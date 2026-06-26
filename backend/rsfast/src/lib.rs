//! Accélérateur natif des étages pur-NumPy du pipeline RawStudio.
//!
//! Chaque fonction opère **en place** sur un buffer f32 RGB entrelacé (R,G,B,R,G,B…)
//! de `npix` pixels, fourni par NumPy via ctypes. Le parallélisme découpe les pixels
//! en tranches traitées par `std::thread` (1 thread/cœur), sans dépendance externe.
//!
//! Objectif : **parité pixel** avec `backend/app/pipeline.py`. Les opérations
//! reproduisent exactement la même arithmétique (mêmes LUT sRGB 4096, même troncature
//! d'indice `astype(int32)`, mêmes formules).

use std::sync::OnceLock;
use std::thread;

// ----------------------------------------------------------------- parallélisme

fn nthreads() -> usize {
    thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
}

/// Applique `f(pixel_global_index, &mut r, &mut g, &mut b)` à chaque pixel, en parallèle.
/// L'adresse du buffer est passée en `usize` (Send) puis reconstruite par thread ; le
/// découpage en tranches disjointes garantit l'absence de chevauchement d'écriture.
fn par_pixels<F>(ptr: *mut f32, npix: usize, f: F)
where
    F: Fn(usize, &mut f32, &mut f32, &mut f32) + Sync,
{
    if npix == 0 {
        return;
    }
    let nt = nthreads().min(npix).max(1);
    let chunk = npix.div_ceil(nt);
    let addr = ptr as usize;
    let fref = &f;
    thread::scope(|s| {
        for t in 0..nt {
            let start = t * chunk;
            if start >= npix {
                break;
            }
            let end = (start + chunk).min(npix);
            s.spawn(move || {
                let p = addr as *mut f32;
                for i in start..end {
                    unsafe {
                        let r = p.add(i * 3);
                        let g = p.add(i * 3 + 1);
                        let b = p.add(i * 3 + 2);
                        fref(i, &mut *r, &mut *g, &mut *b);
                    }
                }
            });
        }
    });
}

// ----------------------------------------------------------------- LUT sRGB 4096

const LUT_N: usize = 4096;

struct SrgbLuts {
    lin: Vec<f32>,
    srgb: Vec<f32>,
}

fn srgb_luts() -> &'static SrgbLuts {
    static LUTS: OnceLock<SrgbLuts> = OnceLock::new();
    LUTS.get_or_init(|| {
        // Identique à pipeline._luts() : linspace(0,1,4096), calcul en f64 puis cast f32.
        let mut lin = Vec::with_capacity(LUT_N);
        let mut srgb = Vec::with_capacity(LUT_N);
        for i in 0..LUT_N {
            let x = i as f64 / (LUT_N as f64 - 1.0);
            let l = if x <= 0.04045 {
                x / 12.92
            } else {
                ((x + 0.055) / 1.055).powf(2.4)
            };
            let s = if x <= 0.0031308 {
                x * 12.92
            } else {
                1.055 * x.powf(1.0 / 2.4) - 0.055
            };
            lin.push(l as f32);
            srgb.push(s as f32);
        }
        SrgbLuts { lin, srgb }
    })
}

/// Reproduit `_apply_lut` : idx = clip(v,0,1)*(N-1) tronqué vers 0 (astype int32).
#[inline(always)]
fn lut_lookup(lut: &[f32], v: f32) -> f32 {
    let n = lut.len();
    let c = v.clamp(0.0, 1.0);
    let idx = (c * (n as f32 - 1.0)) as usize; // troncature vers 0, comme astype(int32)
    lut[idx.min(n - 1)]
}

// ----------------------------------------------------------------- étages

/// linear stage : sRGB→linéaire (LUT), gains WB×exposition, linéaire→sRGB (LUT).
/// `rg/gg/bg` = gains WB déjà multipliés par ev côté Python (rg*ev, gg*ev, bg*ev).
#[no_mangle]
pub extern "C" fn rs_linear_stage(ptr: *mut f32, npix: usize, rg: f32, gg: f32, bg: f32) {
    let lut = srgb_luts();
    par_pixels(ptr, npix, |_, r, g, b| {
        let lr = lut_lookup(&lut.lin, *r) * rg;
        let lg = lut_lookup(&lut.lin, *g) * gg;
        let lb = lut_lookup(&lut.lin, *b) * bg;
        *r = lut_lookup(&lut.srgb, lr);
        *g = lut_lookup(&lut.srgb, lg);
        *b = lut_lookup(&lut.srgb, lb);
    });
}

/// whites/blacks : (img - bp) / denom, denom = max(wp-bp, 0.05).
#[no_mangle]
pub extern "C" fn rs_whites_blacks(ptr: *mut f32, npix: usize, bp: f32, denom: f32) {
    let inv = 1.0 / denom;
    par_pixels(ptr, npix, |_, r, g, b| {
        *r = (*r - bp) * inv;
        *g = (*g - bp) * inv;
        *b = (*b - bp) * inv;
    });
}

/// contrast : c>0 → fondu vers courbe en S douce ; c<0 → réduction linéaire autour de 0.5.
#[no_mangle]
pub extern "C" fn rs_contrast(ptr: *mut f32, npix: usize, c: f32) {
    let pos = c > 0.0;
    let nc = -c;
    let f = |x: f32| -> f32 {
        let x = x.clamp(0.0, 1.0);
        if pos {
            let s = x * x * (3.0 - 2.0 * x);
            x + c * (s - x)
        } else {
            x + nc * ((0.5 + (x - 0.5) * 0.6) - x)
        }
    };
    par_pixels(ptr, npix, |_, r, g, b| {
        *r = f(*r);
        *g = f(*g);
        *b = f(*b);
    });
}

/// curve : LUT par canal (composée maître∘canal côté Python). Pointeurs nuls = canal inchangé.
#[no_mangle]
pub extern "C" fn rs_curve(
    ptr: *mut f32,
    npix: usize,
    lut_r: *const f32,
    lut_g: *const f32,
    lut_b: *const f32,
    lut_len: usize,
) {
    let mk = |p: *const f32| -> Option<&'static [f32]> {
        if p.is_null() {
            None
        } else {
            Some(unsafe { std::slice::from_raw_parts(p, lut_len) })
        }
    };
    let (lr, lg, lb) = (mk(lut_r), mk(lut_g), mk(lut_b));
    par_pixels(ptr, npix, |_, r, g, b| {
        if let Some(l) = lr {
            *r = lut_lookup(l, *r);
        }
        if let Some(l) = lg {
            *g = lut_lookup(l, *g);
        }
        if let Some(l) = lb {
            *b = lut_lookup(l, *b);
        }
    });
}

/// HSL 8 bandes + vibrance + saturation, opérant **en place** sur un buffer HSV entrelacé
/// (canal 0 = teinte 0..360, 1 = saturation 0..1, 2 = valeur 0..1) issu de `cv2.cvtColor`.
/// `centers/bh/bs/bl` : tableaux de `nbands` floats (teinte centrale + h/s/l par bande, en %).
/// Reproduit exactement `_apply_color` (mod euclidien comme NumPy `%`, mêmes formules).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn rs_hsl(
    ptr: *mut f32,
    npix: usize,
    centers: *const f32,
    bh: *const f32,
    bs: *const f32,
    bl: *const f32,
    nbands: usize,
    vibrance: f32,
    saturation: f32,
) {
    let centers = unsafe { std::slice::from_raw_parts(centers, nbands) };
    let bh = unsafe { std::slice::from_raw_parts(bh, nbands) };
    let bs = unsafe { std::slice::from_raw_parts(bs, nbands) };
    let bl = unsafe { std::slice::from_raw_parts(bl, nbands) };
    let pi = std::f32::consts::PI;
    par_pixels(ptr, npix, |_, h, s, v| {
        let mut h_shift = 0.0f32;
        let mut s_mult = 1.0f32;
        let mut v_mult = 1.0f32;
        for k in 0..nbands {
            if bh[k] == 0.0 && bs[k] == 0.0 && bl[k] == 0.0 {
                continue; // bande neutre : ignorée (comme côté Python)
            }
            // _band_weight : dist angulaire repliée, demi-largeur 45°.
            let dist = (((*h - centers[k]) + 180.0).rem_euclid(360.0) - 180.0).abs();
            let bw = 0.5 * (1.0 + (pi * (dist / 45.0).min(1.0)).cos());
            let w = bw * (*s * 4.0).min(1.0); // pas d'effet sur les gris
            h_shift += w * (bh[k] / 100.0) * 30.0;
            s_mult *= 1.0 + w * (bs[k] / 100.0);
            v_mult *= 1.0 + w * (bl[k] / 100.0) * 0.65;
        }
        *h = (*h + h_shift).rem_euclid(360.0);
        let mut sv = *s * s_mult.max(0.0);
        let vv = *v * v_mult.max(0.0);
        if vibrance != 0.0 {
            let vib = vibrance / 100.0;
            sv = if vib > 0.0 {
                sv * (1.0 + vib * (1.0 - sv) * 1.2)
            } else {
                sv * (1.0 + vib * 0.85)
            };
        }
        if saturation != 0.0 {
            sv *= 1.0 + saturation / 100.0;
        }
        *s = sv.clamp(0.0, 1.0);
        *v = vv.clamp(0.0, 1.0);
    });
}

/// vignette : gain = 2^(v*1.3*smoothstep(0.3,1,r)), r = dist normalisée au centre / sqrt(2).
#[no_mangle]
pub extern "C" fn rs_vignette(ptr: *mut f32, npix: usize, w: usize, h: usize, v: f32) {
    let inv_w = 1.0 / (w.saturating_sub(1).max(1) as f32);
    let inv_h = 1.0 / (h.saturating_sub(1).max(1) as f32);
    let inv_sqrt2 = 1.0 / 2.0_f32.sqrt();
    let smoothstep = |e0: f32, e1: f32, x: f32| -> f32 {
        let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    par_pixels(ptr, npix, |i, r, g, b| {
        let px = (i % w) as f32;
        let py = (i / w) as f32;
        let nx = px * inv_w * 2.0 - 1.0;
        let ny = py * inv_h * 2.0 - 1.0;
        let rad = (nx * nx + ny * ny).sqrt() * inv_sqrt2;
        let gain = (v * 1.3 * smoothstep(0.3, 1.0, rad)).exp2();
        *r *= gain;
        *g *= gain;
        *b *= gain;
    });
}
