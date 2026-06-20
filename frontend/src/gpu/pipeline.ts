/**
 * Moteur de pipeline GPU (WebGL2) — passes multiples.
 *
 * Reproduit le pipeline Python dans l'ordre, sur la base déjà décodée :
 *   géométrie/recadrage → WB+expo → HL/ombres → blancs/noirs → contraste → courbe → HSL/vibrance/sat
 *   → clarté → dehaze → retouches locales → réduction de bruit (chroma + luminance) → netteté → vignettage.
 * La géométrie est un pré-pass mis en cache sur la base ; tout le reste tourne sur l'image recadrée.
 *
 * Les ops « à voisinage » (HL/ombres, clarté, netteté, dehaze) utilisent un flou gaussien
 * séparable. Les masques de luminance (HL/ombres, clarté) sont calculés à résolution
 * réduite (downscale ∝ sigma) puis ré-échantillonnés en LINEAR : visuellement
 * équivalent et bien plus rapide. La netteté utilise un petit flou pleine résolution.
 * La réduction de bruit luminance est un bilatéral séparable (approx. du bilatéral 2D OpenCV).
 *
 * Pas encore portés (étape 3 / 4) : masques locaux, géométrie.
 */
import { buildCurveTexture } from "./curveLut";
import { HSL_BANDS } from "../types";
import type { EditState, LocalAdjust } from "../types";

const ZERO_HSL = new Float32Array(24);

const VERSION = "#version 300 es\n";

const VERT = VERSION + `
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// Fonctions communes à tous les fragments
const PRELUDE = `
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
vec3 s2l(vec3 c){ return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045,c)); }
vec3 l2s(vec3 c){ c=clamp(c,0.,1.); return mix(c*12.92, 1.055*pow(c,vec3(1./2.4))-0.055, step(0.0031308,c)); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 rgb2hsv(vec3 c){
  float mx=max(c.r,max(c.g,c.b)), mn=min(c.r,min(c.g,c.b)), d=mx-mn, h=0.;
  if(d>1e-10){
    if(mx==c.r) h=mod((c.g-c.b)/d,6.);
    else if(mx==c.g) h=(c.b-c.r)/d+2.;
    else h=(c.r-c.g)/d+4.;
    h*=60.; if(h<0.) h+=360.;
  }
  return vec3(h, mx<=0.?0.:d/mx, mx);
}
vec3 hsv2rgb(vec3 v3){
  float h=v3.x, s=v3.y, v=v3.z;
  float c=v*s, x=c*(1.-abs(mod(h/60.,2.)-1.)), m=v-c;
  vec3 r;
  if(h<60.) r=vec3(c,x,0.); else if(h<120.) r=vec3(x,c,0.);
  else if(h<180.) r=vec3(0.,c,x); else if(h<240.) r=vec3(0.,x,c);
  else if(h<300.) r=vec3(x,0.,c); else r=vec3(c,0.,x);
  return r+m;
}
`;

// 1) WB + exposition (linéaire)
const F_LINEAR = VERSION + PRELUDE + `
uniform vec3 u_wb; uniform float u_expo;
void main(){
  vec3 c = texture(u_tex, v_uv).rgb;
  o = vec4(l2s(s2l(c) * u_wb * exp2(u_expo)), 1.);
}`;

// 2) downscale + luma (pour les masques de luminance)
const F_LUMA = VERSION + PRELUDE + `
void main(){ float l = luma(texture(u_tex, v_uv).rgb); o = vec4(l, l, l, 1.); }`;

// 3) flou gaussien séparable (1D)
const MAX_TAPS = 24;
const F_BLUR = VERSION + PRELUDE + `
uniform vec2 u_dir; uniform float u_w[${MAX_TAPS}]; uniform int u_radius;
void main(){
  vec4 sum = texture(u_tex, v_uv) * u_w[0];
  for(int i=1;i<${MAX_TAPS};i++){
    if(i>u_radius) break;
    sum += (texture(u_tex, v_uv + u_dir*float(i)) + texture(u_tex, v_uv - u_dir*float(i))) * u_w[i];
  }
  o = sum;
}`;

// 4) HL/ombres (masque flou) + blancs/noirs + contraste + courbe + HSL/vibrance/sat
const F_TONE = VERSION + PRELUDE + `
uniform sampler2D u_lumaBlur; uniform int u_hasHL; uniform float u_hl; uniform float u_sh;
uniform float u_whites; uniform float u_blacks; uniform float u_contrast;
uniform sampler2D u_curve; uniform int u_hasCurve;
uniform int u_hasHsl; uniform vec3 u_hsl[8]; uniform float u_vibrance; uniform float u_saturation;
const float CENTERS[8] = float[8](0.,30.,60.,120.,180.,240.,280.,320.);
float bandW(float hue, float center){
  float dist = abs(mod((hue-center)+180.,360.)-180.);
  return 0.5*(1.+cos(3.14159265*min(dist/45.,1.)));
}
float contrast1(float xv, float k){
  if(k>0.){ float s=xv*xv*(3.-2.*xv); return xv + k*(s-xv); }
  return xv + (-k)*((0.5+(xv-0.5)*0.6)-xv);
}
void main(){
  vec3 c = texture(u_tex, v_uv).rgb;

  if(u_hasHL==1){                                   // HL/ombres (masque de luminance floutée)
    float lb = texture(u_lumaBlur, v_uv).r;
    float gain = 1.;
    if(u_hl!=0.){ float wH = pow(smoothstep(0.35,0.95,lb),1.2); gain *= exp2(u_hl/100.*0.9*wH); }
    if(u_sh!=0.){ float wS = pow(1.-smoothstep(0.05,0.65,lb),1.2); gain *= exp2(u_sh/100.*0.9*wS); }
    c *= gain;
  }

  float wp = 1. - 0.25*(u_whites/100.);             // blancs/noirs
  float bp = -0.20*(u_blacks/100.);
  c = (c - bp) / max(wp - bp, 0.05);

  c = clamp(c,0.,1.);                               // contraste
  float k = u_contrast/100.;
  c = vec3(contrast1(c.r,k), contrast1(c.g,k), contrast1(c.b,k));

  c = clamp(c,0.,1.);                               // courbe
  if(u_hasCurve==1) c = vec3(texture(u_curve,vec2(c.r,0.5)).r, texture(u_curve,vec2(c.g,0.5)).g, texture(u_curve,vec2(c.b,0.5)).b);

  vec3 hsv = rgb2hsv(clamp(c,0.,1.));               // HSL + vibrance + saturation
  float h=hsv.x, s=hsv.y, v=hsv.z;
  if(u_hasHsl==1){
    float hShift=0., sMul=1., vMul=1.;
    for(int i=0;i<8;i++){
      vec3 b=u_hsl[i];
      if(b.x==0.&&b.y==0.&&b.z==0.) continue;
      float w = bandW(h, CENTERS[i]) * min(s*4.,1.);
      hShift += w*(b.x/100.)*30.; sMul *= 1.+w*(b.y/100.); vMul *= 1.+w*(b.z/100.)*0.65;
    }
    h=mod(h+hShift,360.); s*=max(sMul,0.); v*=max(vMul,0.);
  }
  if(u_vibrance!=0.){ float vib=u_vibrance/100.; s = vib>0.? s*(1.+vib*(1.-s)*1.2) : s*(1.+vib*0.85); }
  if(u_saturation!=0.) s *= 1.+u_saturation/100.;
  o = vec4(hsv2rgb(vec3(h, clamp(s,0.,1.), clamp(v,0.,1.))), 1.);
}`;

// 5) clarté (contraste local sur la luminance, pondéré tons moyens)
const F_CLARITY = VERSION + PRELUDE + `
uniform sampler2D u_lumaBlur; uniform float u_clarity;
void main(){
  vec3 c = texture(u_tex, v_uv).rgb;
  float l = luma(c);
  float detail = l - texture(u_lumaBlur, v_uv).r;
  float mid = 1. - pow(abs(2.*clamp(l,0.,1.)-1.), 2.);
  o = vec4(c + (u_clarity/100.*0.9*detail*mid), 1.);
}`;

// 5bis) défrange : désature les franges pourpres/vertes sur les bords (aberration chromatique)
const F_DEFRINGE = VERSION + PRELUDE + `
uniform sampler2D u_blur; uniform float u_purple; uniform float u_green;
void main(){
  vec3 c = texture(u_tex, v_uv).rgb;
  float l = luma(c);
  float edge = clamp(abs(l - luma(texture(u_blur, v_uv).rgb)) * 8.0, 0.0, 1.0);
  float pm = clamp(min(c.r, c.b) - c.g, 0.0, 1.0);
  float gm = clamp(c.g - max(c.r, c.b), 0.0, 1.0);
  float fp = clamp(pm * edge * (u_purple/100.0) * 4.0, 0.0, 1.0);
  float fg = clamp(gm * edge * (u_green/100.0) * 4.0, 0.0, 1.0);
  o = vec4(mix(c, vec3(l), max(fp, fg)), 1.0);
}`;

// 6) netteté (masque flou) + vignettage — passe finale (rendu écran)
const F_FINAL = VERSION + PRELUDE + `
uniform sampler2D u_blur; uniform float u_sharpen; uniform float u_vignette; uniform int u_showClip;
void main(){
  vec3 c = texture(u_tex, v_uv).rgb;
  if(u_sharpen>0.){
    float detail = luma(c) - luma(texture(u_blur, v_uv).rgb);
    c += (u_sharpen/100.) * detail;
  }
  if(u_vignette!=0.){
    vec2 p = v_uv*2.-1.;
    float r = length(p)/1.41421356;
    float ss = smoothstep(0.3, 1.0, r);
    c *= exp2(u_vignette/100.*1.3*ss);
  }
  c = clamp(c, 0., 1.);
  if(u_showClip==1){                                 // alertes d'écrêtage (mêmes seuils/couleurs que le CPU)
    if(all(greaterThanEqual(c, vec3(0.98)))) c = vec3(235., 40., 40.)/255.;
    else if(all(lessThanEqual(c, vec3(0.016)))) c = vec3(50., 90., 235.)/255.;
  }
  o = vec4(c, 1.);
}`;

// 7) dark channel érodé (.r) + canal max (.g) — base du dehaze (résolution réduite)
const F_DCVAL = VERSION + PRELUDE + `
uniform vec2 u_texel;
void main(){
  float dmin = 1.0;
  for(int dy=-1;dy<=1;dy++) for(int dx=-1;dx<=1;dx++){
    vec3 c = texture(u_tex, v_uv + vec2(float(dx),float(dy))*u_texel).rgb;
    dmin = min(dmin, min(c.r, min(c.g, c.b)));
  }
  vec3 cc = texture(u_tex, v_uv).rgb;
  o = vec4(dmin, max(cc.r, max(cc.g, cc.b)), 0.0, 1.0);
}`;

// 8) lumière atmosphérique a ≈ percentile haut du canal max (réduction max sur grille → 1 px)
const F_REDUCE_MAX = VERSION + PRELUDE + `
void main(){
  const int N = 12;
  float m = 0.0;
  for(int y=0;y<N;y++) for(int x=0;x<N;x++)
    m = max(m, texture(u_tex, (vec2(float(x),float(y))+0.5)/float(N)).g);
  o = vec4(m, m, m, 1.0);
}`;

// 9) dehaze (dark channel prior simplifié) — fidèle à _apply_dehaze
const F_DEHAZE = VERSION + PRELUDE + `
uniform sampler2D u_dark; uniform sampler2D u_amax; uniform float u_dehaze;
void main(){
  vec3 x = clamp(texture(u_tex, v_uv).rgb, 0., 1.);
  float amt = u_dehaze/100.;
  vec3 outc;
  if(amt < 0.){                                   // voile artistique (sans voisinage)
    outc = x*(1.+amt*0.35) + vec3((-amt)*0.35*0.92);
  } else {
    float dark = texture(u_dark, v_uv).r;
    float a = max(texture(u_amax, vec2(0.5)).g, 0.5);
    float t = clamp(1. - 0.85*amt*dark/a, 0.25, 1.0);
    outc = clamp((x - a)/t + a, 0., 1.) * (1. + 0.1*amt);
    vec3 hsv = rgb2hsv(clamp(outc, 0., 1.));       // compensation : vibrance = 12*amt
    float vib = 12.*amt/100.;
    hsv.y = clamp(hsv.y*(1. + vib*(1.-hsv.y)*1.2), 0., 1.);
    outc = hsv2rgb(hsv);
  }
  o = vec4(clamp(outc, 0., 1.), 1.);
}`;

// 10) RGB → YCrCb (BT.601, delta 0.5) pour la réduction de bruit chroma
const F_YCC = VERSION + PRELUDE + `
void main(){
  vec3 c = clamp(texture(u_tex, v_uv).rgb, 0., 1.);
  float Y = dot(c, vec3(0.299, 0.587, 0.114));
  o = vec4(Y, (c.r - Y)*0.713 + 0.5, (c.b - Y)*0.564 + 0.5, 1.0);
}`;

// 11) recombine Y (net) + Cr/Cb floutés → RGB (lissage chroma)
const F_CHROMA = VERSION + PRELUDE + `
uniform sampler2D u_blur;
void main(){
  float Y = texture(u_tex, v_uv).r;
  vec2 cc = texture(u_blur, v_uv).gb - 0.5;
  o = vec4(Y + 1.403*cc.x, Y - 0.714*cc.x - 0.344*cc.y, Y + 1.773*cc.y, 1.0);
}`;

// 12) bilatéral séparable (NR luminance, préserve les bords) + fondu sur l'original
const F_BILATERAL = VERSION + PRELUDE + `
uniform vec2 u_dir; uniform int u_radius; uniform float u_sigmaS; uniform float u_sigmaC;
uniform sampler2D u_orig; uniform int u_doBlend; uniform float u_blend;
void main(){
  vec3 center = texture(u_tex, v_uv).rgb;
  vec3 sum = center; float wsum = 1.0;
  float c2 = 2.*u_sigmaC*u_sigmaC, s2 = 2.*u_sigmaS*u_sigmaS;
  for(int i=1;i<${MAX_TAPS};i++){
    if(i>u_radius) break;
    float sw = exp(-float(i*i)/s2);
    vec3 cp = texture(u_tex, v_uv + u_dir*float(i)).rgb;
    vec3 cm = texture(u_tex, v_uv - u_dir*float(i)).rgb;
    float dp = distance(cp, center), dm = distance(cm, center);
    float wp = sw*exp(-(dp*dp)/c2), wm = sw*exp(-(dm*dm)/c2);
    sum += cp*wp + cm*wm; wsum += wp + wm;
  }
  vec3 sm = sum/wsum;
  if(u_doBlend==1){ vec3 orig = texture(u_orig, v_uv).rgb; sm = orig + (sm - orig)*u_blend; }
  o = vec4(sm, 1.0);
}`;

// 13) retouche locale : netteté finale du mini-pipeline + masque (linéaire/radial/pinceau) + fondu
//     Masque en coordonnées image (y vers le bas) : muv = (v_uv.x, 1 - v_uv.y), comme masks.py.
// Valeur du masque local (partagée entre lblend et l'overlay rouge) — muv = coords image (y bas).
const MASK_GLSL = `
uniform sampler2D u_brush;  // masque rasterisé (pinceau / IA)
uniform int u_kind;         // 0 linéaire, 1 radial, 2 pinceau, 3 IA, 4 plage luminance, 5 plage couleur
uniform int u_invert;
uniform float u_aiK;        // dureté du masque IA (contraste autour de 0.5)
uniform vec4 u_lin;         // x0,y0,x1,y1
uniform vec4 u_rad;         // cx,cy,rx,ry
uniform vec3 u_rad2;        // angle(rad), feather, aspect = w/h
uniform vec4 u_lr;          // plage luminance : lo, hi, smooth
uniform vec4 u_cr;          // plage couleur : hue, range, smooth, sat_min
// muv = coords image (y bas) pour les masques géométriques ; col = couleur du pixel (plages).
float computeMask(vec2 muv, vec3 col){
  float m;
  if(u_kind==0){                                   // dégradé linéaire
    vec2 d = u_lin.zw - u_lin.xy;
    float n2 = dot(d, d);
    m = n2 < 1e-8 ? 1.0 : 1.0 - smoothstep(0.0, 1.0, dot(muv - u_lin.xy, d) / n2);
  } else if(u_kind==1){                            // radial (ellipse, aspect corrigé)
    float ar = u_rad2.z;
    vec2 p = vec2((muv.x - u_rad.x) * ar, muv.y - u_rad.y);
    float a = u_rad2.x;
    if(abs(a) > 1e-4){ float ca = cos(a), sa = sin(a); p = vec2(p.x*ca + p.y*sa, -p.x*sa + p.y*ca); }
    float rx = max(u_rad.z, 1e-3), ry = max(u_rad.w, 1e-3), feather = clamp(u_rad2.y, 0.0, 1.0);
    vec2 q = vec2(p.x / (rx*ar), p.y / ry);
    float dist = sqrt(q.x*q.x + q.y*q.y);
    m = 1.0 - smoothstep(max(1.0 - feather, 0.0), 1.0 + 0.25*feather, dist);
  } else if(u_kind==2){                            // pinceau (texture)
    m = texture(u_brush, muv).r;
  } else if(u_kind==3){                            // masque IA (texture + dureté)
    m = texture(u_brush, muv).r;
    m = clamp((m - 0.5) * u_aiK + 0.5, 0.0, 1.0);
  } else if(u_kind==4){                            // plage de luminance
    float l = luma(col);
    float lo = u_lr.x, hi = u_lr.y, sm = max(u_lr.z, 1e-3);
    m = smoothstep(lo - sm, lo, l) * (1.0 - smoothstep(hi, hi + sm, l));
  } else {                                         // plage de couleur
    vec3 hsv = rgb2hsv(clamp(col, 0.0, 1.0));
    float hd = abs(mod((hsv.x - u_cr.x) + 180.0, 360.0) - 180.0);
    float hueW = 1.0 - smoothstep(u_cr.y, u_cr.y + max(u_cr.z, 1e-3), hd);
    float satW = smoothstep(0.0, max(u_cr.w, 1e-3), hsv.y);
    m = hueW * satW;
  }
  if(u_invert == 1) m = 1.0 - m;
  return clamp(m, 0.0, 1.0);
}`;

const F_LBLEND = VERSION + PRELUDE + MASK_GLSL + `
uniform sampler2D u_blur;   // flou de l'image ajustée (pour la netteté)
uniform sampler2D u_orig;   // image avant ce masque
uniform float u_sharpen;
void main(){
  vec3 adj = texture(u_tex, v_uv).rgb;
  if(u_sharpen>0.){
    float detail = luma(adj) - luma(texture(u_blur, v_uv).rgb);
    adj += (u_sharpen/100.) * detail;
  }
  float m = computeMask(vec2(v_uv.x, 1.0 - v_uv.y), texture(u_orig, v_uv).rgb);
  o = vec4(mix(texture(u_orig, v_uv).rgb, adj, m), 1.0);
}`;

// Overlay rouge du masque sélectionné (touche O) — reproduit _overlay_mask côté Python.
const F_MASKOVL = VERSION + PRELUDE + MASK_GLSL + `
void main(){
  vec3 img = texture(u_tex, v_uv).rgb;
  float m = computeMask(vec2(v_uv.x, 1.0 - v_uv.y), img);
  o = vec4(mix(img, vec3(1.0, 0.15, 0.15), m * 0.6), 1.0);
}`;

// 14) mélange de deux textures (base bruitée ↔ base débruitée IA) — réduction de bruit IA.
const F_BLEND = VERSION + PRELUDE + `
uniform sampler2D u_tex2; uniform float u_amt;
void main(){ o = vec4(mix(texture(u_tex,v_uv).rgb, texture(u_tex2,v_uv).rgb, u_amt), 1.); }`;

// 0) géométrie (pré-pass sur la base) — mapping INVERSE output→base, fidèle à apply_geometry.
//    Coords « sample » y vers le haut (= v_uv ; la base est uploadée FLIP_Y). Ordre inverse :
//    undo crop → undo redressement+auto-crop → undo miroirs → undo rotation 90°.
const F_GEOM = VERSION + PRELUDE + `
uniform int u_rotK; uniform int u_flipH; uniform int u_flipV;
uniform float u_angle; uniform vec2 u_wrwh; uniform float u_aspect; uniform vec4 u_crop;
void main(){
  vec2 p;
  p.x = u_crop.x + v_uv.x * u_crop.z;                 // undo crop (cx + x·cw)
  p.y = 1.0 - u_crop.y - u_crop.w * (1.0 - v_uv.y);   // y depuis le haut → sample y haut
  if(u_angle != 0.0){                                 // undo redressement (cv2 getRotationMatrix2D, y bas)
    p.x = 0.5 + (p.x - 0.5) * u_wrwh.x;               // undo auto-crop centré
    p.y = 0.5 + (p.y - 0.5) * u_wrwh.y;
    float a = u_aspect;
    float u = (p.x - 0.5) * a, v = 0.5 - p.y;         // → pixels centrés, y bas
    float A = cos(u_angle), B = sin(u_angle);
    float us = A*u + B*v, vs = -B*u + A*v;            // src = M·dst
    p.x = 0.5 + us / a; p.y = 0.5 - vs;
  }
  if(u_flipH == 1) p.x = 1.0 - p.x;
  if(u_flipV == 1) p.y = 1.0 - p.y;
  vec2 b;                                             // undo rot90 (output→base)
  if(u_rotK == 0) b = p;
  else if(u_rotK == 1) b = vec2(p.y, 1.0 - p.x);
  else if(u_rotK == 2) b = vec2(1.0 - p.x, 1.0 - p.y);
  else b = vec2(1.0 - p.y, p.x);
  o = vec4(texture(u_tex, b).rgb, 1.0);
}`;

const COPY_W = new Float32Array(MAX_TAPS); COPY_W[0] = 1; // poids neutre (copie/downscale)

function gaussianWeights(sigma: number): { weights: Float32Array; radius: number } {
  const radius = Math.min(Math.max(Math.ceil(2.5 * sigma), 1), MAX_TAPS - 1);
  const w = new Float32Array(MAX_TAPS);
  let sum = 0;
  for (let i = 0; i <= radius; i++) {
    w[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += i === 0 ? w[i] : 2 * w[i];
  }
  for (let i = 0; i <= radius; i++) w[i] /= sum;
  return { weights: w, radius };
}

interface RT { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number; }

export class GpuPipeline {
  private gl: WebGL2RenderingContext;
  private progs: Record<string, WebGLProgram> = {};
  private uloc: Record<string, Record<string, WebGLUniformLocation | null>> = {};
  private rts = new Map<string, RT>();
  private baseTex: WebGLTexture;
  private denoiseTex: WebGLTexture | null = null;   // base débruitée IA (chargée en lazy)
  private denoiseLoaded = false;
  private curveTex: WebGLTexture;
  private brushTex = new Map<string, { tex: WebGLTexture; key: string }>(); // masque pinceau rasterisé, par id
  private brushCanvas?: HTMLCanvasElement;
  private aiTex = new Map<string, { tex: WebGLTexture; ref: string; loaded: boolean }>(); // bitmap masque IA, par id
  /** Appelé quand un bitmap de masque IA fini de charger → demande un nouveau rendu. */
  requestRerender: (() => void) | null = null;
  private lastCurve = "";
  private geoBase = { key: "", rt: null as RT | null };   // cache géométrie de la base bruitée
  private geoAI = { key: "", rt: null as RT | null };      // cache géométrie de la base débruitée
  private hasCurve = false;
  private colorType: number;        // HALF_FLOAT si dispo, sinon UNSIGNED_BYTE
  private colorInternal: number;
  workW = 0;
  workH = 0;
  fullLong = 1;
  private presentPx = new Uint8Array(4);

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const floatRender = gl.getExtension("EXT_color_buffer_float");
    this.colorType = floatRender ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    this.colorInternal = floatRender ? gl.RGBA16F : gl.RGBA8;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const sources: Record<string, string> = {
      linear: F_LINEAR, luma: F_LUMA, blur: F_BLUR, tone: F_TONE, clarity: F_CLARITY, final: F_FINAL,
      dcval: F_DCVAL, reducemax: F_REDUCE_MAX, dehaze: F_DEHAZE, ycc: F_YCC, chroma: F_CHROMA,
      bilateral: F_BILATERAL, lblend: F_LBLEND, geom: F_GEOM, maskovl: F_MASKOVL, blend: F_BLEND,
      defringe: F_DEFRINGE,
    };
    for (const [name, frag] of Object.entries(sources)) {
      const p = this.link(VERT, frag);
      this.progs[name] = p;
      const loc = gl.getAttribLocation(p, "a_pos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.uloc[name] = {};
    }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.baseTex = this.newTex();
    this.curveTex = this.newTex();
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  }

  private link(vsrc: string, fsrc: string): WebGLProgram {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "compile");
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vsrc));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fsrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    return p;
  }

  private u(prog: string, name: string): WebGLUniformLocation | null {
    const cache = this.uloc[prog];
    if (!(name in cache)) cache[name] = this.gl.getUniformLocation(this.progs[prog], name);
    return cache[name];
  }

  private newTex(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Render target (texture+FBO) couleur, mis en cache par clé+taille. */
  private rt(key: string, w: number, h: number): RT {
    const ck = `${key}:${w}x${h}`;
    let r = this.rts.get(ck);
    if (r) return r;
    // libère une autre taille pour la même clé
    for (const [k, v] of this.rts) {
      if (k.startsWith(key + ":")) { this.gl.deleteTexture(v.tex); this.gl.deleteFramebuffer(v.fbo); this.rts.delete(k); }
    }
    const gl = this.gl;
    const tex = this.newTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, this.colorInternal, w, h, 0, gl.RGBA, this.colorType, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    r = { tex, fbo, w, h };
    this.rts.set(ck, r);
    return r;
  }

  setBase(img: HTMLImageElement, fullLong: number) {
    const gl = this.gl;
    this.workW = img.naturalWidth;
    this.workH = img.naturalHeight;
    this.fullLong = Math.max(fullLong, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.baseTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.lastCurve = "";
    this.geoBase = { key: "", rt: null };     // la géométrie cachée appartenait à l'ancienne photo
    this.geoAI = { key: "", rt: null };
    this.denoiseLoaded = false;               // la base débruitée appartenait à l'ancienne photo
    for (const { tex } of this.brushTex.values()) gl.deleteTexture(tex); // idem masques pinceau
    this.brushTex.clear();
    for (const { tex } of this.aiTex.values()) gl.deleteTexture(tex);    // idem bitmaps masques IA
    this.aiTex.clear();
  }

  /** Base débruitée par IA (même résolution/orientation que la base) — chargée en lazy par
   *  useGpuPreview quand le réglage NR IA est actif. Mélangée à la base bruitée dans render(). */
  setDenoiseBase(img: HTMLImageElement) {
    const gl = this.gl;
    if (!this.denoiseTex) this.denoiseTex = this.newTex();
    gl.bindTexture(gl.TEXTURE_2D, this.denoiseTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.geoAI = { key: "", rt: null };
    this.denoiseLoaded = true;
  }

  /** Texture d'un masque IA : noir (= masque vide) tant que le PNG n'est pas chargé,
   *  puis re-rendu via `requestRerender` une fois le bitmap arrivé. Cache par id. */
  private aiTexture(loc: LocalAdjust): WebGLTexture {
    const gl = this.gl;
    const ref = String(loc.params?.ref ?? "");
    const cached = this.aiTex.get(loc.id);
    if (cached && cached.ref === ref) return cached.tex;
    if (cached) gl.deleteTexture(cached.tex);

    const tex = this.newTex();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                  new Uint8Array([0, 0, 0, 255]));        // placeholder noir = aucun effet
    const entry = { tex, ref, loaded: false };
    this.aiTex.set(loc.id, entry);
    if (ref) {
      const img = new Image();
      img.onload = () => {
        if (this.aiTex.get(loc.id) !== entry) return;     // photo/masque changé entre-temps
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);    // même orientation que le pinceau
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        entry.loaded = true;
        this.requestRerender?.();
      };
      img.src = `/api/masks/${ref}`;
    }
    return tex;
  }

  /** Rasterise un masque pinceau (Canvas2D) → texture, mis en cache et régénéré quand les traits changent.
   *  Reproduit masks._brush_mask : cercles/lignes par trait (effacement = noir), puis flou gaussien (feather). */
  private brushTexture(loc: LocalAdjust, W: number, H: number): WebGLTexture {
    const params = loc.params || {};
    const strokes: any[] = Array.isArray(params.strokes) ? params.strokes : [];
    const feather = Math.min(Math.max(Number(params.feather ?? 0.5), 0), 1);
    const key = `${W}x${H}|${feather}|${JSON.stringify(strokes)}`;
    const cached = this.brushTex.get(loc.id);
    if (cached && cached.key === key) return cached.tex;

    const gl = this.gl;
    const cv = (this.brushCanvas ??= document.createElement("canvas"));
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d")!;
    ctx.filter = "none";
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    const longEdge = Math.max(W, H);
    let maxRadius = 1;
    // traits dessinés sur une couche, puis floutés en une fois
    const tmp = document.createElement("canvas"); tmp.width = W; tmp.height = H;
    const tc = tmp.getContext("2d")!;
    tc.fillStyle = "#000"; tc.fillRect(0, 0, W, H);
    tc.lineCap = "round"; tc.lineJoin = "round";
    for (const st of strokes) {
      const pts: any[] = Array.isArray(st.points) ? st.points : [];
      if (!pts.length) continue;
      const radius = Math.max(Number(st.size ?? 0.05) * longEdge * 0.5, 1);
      maxRadius = Math.max(maxRadius, radius);
      const v = st.erase ? 0 : 255;
      tc.fillStyle = tc.strokeStyle = `rgb(${v},${v},${v})`;
      const P = pts.map((p) => [Number(p[0]) * (W - 1), Number(p[1]) * (H - 1)] as [number, number]);
      if (P.length > 1) {
        tc.lineWidth = Math.max(2 * radius, 1);
        tc.beginPath(); tc.moveTo(P[0][0], P[0][1]);
        for (let i = 1; i < P.length; i++) tc.lineTo(P[i][0], P[i][1]);
        tc.stroke();
      }
      for (const [x, y] of P) { tc.beginPath(); tc.arc(x, y, radius, 0, 2 * Math.PI); tc.fill(); }
    }
    if (feather > 0) ctx.filter = `blur(${Math.max(maxRadius * feather * 0.6, 0.5)}px)`;
    ctx.drawImage(tmp, 0, 0);
    ctx.filter = "none";

    const tex = cached?.tex ?? this.newTex();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    this.brushTex.set(loc.id, { tex, key });
    return tex;
  }

  /** Dessine une passe plein écran : programme, entrées (unité→texture), sortie (null = canvas). */
  private pass(prog: string, inputs: [number, WebGLTexture][], out: RT | null, w: number, h: number,
               setU: () => void) {
    const gl = this.gl;
    gl.useProgram(this.progs[prog]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fbo : null);
    gl.viewport(0, 0, w, h);
    for (const [unit, tex] of inputs) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); }
    setU();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Flou gaussien d'une texture (downscale ∝ sigma) → renvoie une RT floutée. */
  private blur(src: WebGLTexture, srcW: number, srcH: number, sigmaPx: number,
               keyA: string, keyB: string, downscale: number): RT {
    const gl = this.gl;
    const dw = Math.max(1, Math.round(srcW / downscale));
    const dh = Math.max(1, Math.round(srcH / downscale));
    const sigma = Math.max(sigmaPx / downscale, 0.6);
    const { weights, radius } = gaussianWeights(sigma);
    const a = this.rt(keyA, dw, dh);
    const b = this.rt(keyB, dw, dh);
    // downscale (copie neutre : le filtre LINEAR fait la moyenne)
    this.pass("blur", [[0, src]], a, dw, dh, () => {
      gl.uniform1i(this.u("blur", "u_tex"), 0);
      gl.uniform2f(this.u("blur", "u_dir"), 0, 0);
      gl.uniform1i(this.u("blur", "u_radius"), 0);
      gl.uniform1fv(this.u("blur", "u_w"), COPY_W);
    });
    this.pass("blur", [[0, a.tex]], b, dw, dh, () => {     // horizontal
      gl.uniform2f(this.u("blur", "u_dir"), 1 / dw, 0);
      gl.uniform1i(this.u("blur", "u_radius"), radius);
      gl.uniform1fv(this.u("blur", "u_w"), weights);
    });
    this.pass("blur", [[0, b.tex]], a, dw, dh, () => {     // vertical
      gl.uniform2f(this.u("blur", "u_dir"), 0, 1 / dh);
      gl.uniform1i(this.u("blur", "u_radius"), radius);
      gl.uniform1fv(this.u("blur", "u_w"), weights);
    });
    return a;
  }

  /** Pré-pass géométrie : rotation 90° / miroirs / redressement+auto-crop / recadrage, sur la base.
   *  Mis en cache (recalcul seulement quand la géométrie change). Renvoie la texture source et ses dims
   *  pour le reste du pipeline (qui tourne alors sur l'image recadrée — les masques locaux y sont alignés). */
  private applyGeometry(geo: EditState["geometry"], skipCrop: boolean,
                        src: WebGLTexture = this.baseTex, rtKey = "geo",
                        cache = this.geoBase): { tex: WebGLTexture; w: number; h: number } {
    const gl = this.gl;
    const rotK = ((((geo.rotate || 0) % 360) + 360) % 360) / 90 | 0;
    const angle = geo.straighten || 0;
    const cFull = geo.crop || { x: 0, y: 0, w: 1, h: 1 };
    const c = skipCrop ? { x: 0, y: 0, w: 1, h: 1 } : cFull; // outil crop actif → on rend l'image entière
    const straighten = Math.abs(angle) > 0.01;
    const cropped = c.w < 0.999 || c.h < 0.999 || c.x > 0.001 || c.y > 0.001;
    if (rotK === 0 && !geo.flip_h && !geo.flip_v && !straighten && !cropped)
      return { tex: src, w: this.workW, h: this.workH };

    const key = JSON.stringify({ geo, skipCrop });
    if (key === cache.key && cache.rt)
      return { tex: cache.rt.tex, w: cache.rt.w, h: cache.rt.h };

    let rw = this.workW, rh = this.workH;
    if (rotK === 1 || rotK === 3) [rw, rh] = [rh, rw];
    const aRot = rw / Math.max(rh, 1);
    let wrwh: [number, number] = [1, 1], sw = rw, sh = rh;
    if (straighten) {
      const [Wr, Hr] = largestRotatedRect(rw, rh, angle * Math.PI / 180);
      wrwh = [Wr / rw, Hr / rh]; sw = Wr; sh = Hr;
    }
    const gw = Math.max(Math.round(sw * c.w), 8), gh = Math.max(Math.round(sh * c.h), 8);
    const out = this.rt(rtKey, gw, gh);
    this.pass("geom", [[0, src]], out, gw, gh, () => {
      gl.uniform1i(this.u("geom", "u_tex"), 0);
      gl.uniform1i(this.u("geom", "u_rotK"), rotK);
      gl.uniform1i(this.u("geom", "u_flipH"), geo.flip_h ? 1 : 0);
      gl.uniform1i(this.u("geom", "u_flipV"), geo.flip_v ? 1 : 0);
      gl.uniform1f(this.u("geom", "u_angle"), straighten ? angle * Math.PI / 180 : 0);
      gl.uniform2f(this.u("geom", "u_wrwh"), wrwh[0], wrwh[1]);
      gl.uniform1f(this.u("geom", "u_aspect"), aRot);
      gl.uniform4f(this.u("geom", "u_crop"), c.x, c.y, c.w, c.h);
    });
    cache.key = key; cache.rt = out;
    return { tex: out.tex, w: gw, h: gh };
  }

  /** Retouches locales : pour chaque masque, mini-pipeline (réutilise linear/tone/clarity) + fondu.
   *  Ordre fidèle à _apply_local : linéaire → HL/ombres → contraste → saturation → clarté → netteté. */
  private renderLocals(e: EditState, W: number, H: number, maxd: number, scale: number, cur: RT): RT {
    const gl = this.gl;
    let parity = 0;
    for (const loc of e.locals) {
      const a = loc.adjust;
      if (!Object.values(a).some((v) => Math.abs(Number(v)) > 1e-6)) continue;
      let mid = cur;

      if (a.temp || a.tint || a.exposure) {                       // 1) WB + exposition (réutilise "linear")
        const out = this.rt("lL", W, H);
        const [wr, wg, wb] = wbGains(a.temp, a.tint);
        this.pass("linear", [[0, mid.tex]], out, W, H, () => {
          gl.uniform1i(this.u("linear", "u_tex"), 0);
          gl.uniform3f(this.u("linear", "u_wb"), wr, wg, wb);
          gl.uniform1f(this.u("linear", "u_expo"), a.exposure);
        });
        mid = out;
      }

      if (a.highlights || a.shadows || a.contrast || a.saturation) { // 2) HL/ombres + contraste + sat (réutilise "tone")
        const hasHL = a.highlights !== 0 || a.shadows !== 0;
        let hlBlur = mid;
        if (hasHL) hlBlur = this.blur(mid.tex, W, H, maxd * 0.02, "lhlA", "lhlB", 4);
        const out = this.rt("lT", W, H);
        this.pass("tone", [[0, mid.tex], [1, this.curveTex], [2, hlBlur.tex]], out, W, H, () => {
          gl.uniform1i(this.u("tone", "u_tex"), 0);
          gl.uniform1i(this.u("tone", "u_curve"), 1);
          gl.uniform1i(this.u("tone", "u_lumaBlur"), 2);
          gl.uniform1i(this.u("tone", "u_hasHL"), hasHL ? 1 : 0);
          gl.uniform1f(this.u("tone", "u_hl"), a.highlights);
          gl.uniform1f(this.u("tone", "u_sh"), a.shadows);
          gl.uniform1f(this.u("tone", "u_whites"), 0);
          gl.uniform1f(this.u("tone", "u_blacks"), 0);
          gl.uniform1f(this.u("tone", "u_contrast"), a.contrast);
          gl.uniform1i(this.u("tone", "u_hasCurve"), 0);
          gl.uniform1i(this.u("tone", "u_hasHsl"), 0);
          gl.uniform3fv(this.u("tone", "u_hsl"), ZERO_HSL);
          gl.uniform1f(this.u("tone", "u_vibrance"), 0);
          gl.uniform1f(this.u("tone", "u_saturation"), a.saturation);
        });
        mid = out;
      }

      if (a.clarity !== 0) {                                       // 3) clarté (réutilise "clarity")
        const clBlur = this.blur(mid.tex, W, H, Math.max(8, maxd * 0.012), "lclA", "lclB", 4);
        const out = this.rt("lC", W, H);
        this.pass("clarity", [[0, mid.tex], [1, clBlur.tex]], out, W, H, () => {
          gl.uniform1i(this.u("clarity", "u_tex"), 0);
          gl.uniform1i(this.u("clarity", "u_lumaBlur"), 1);
          gl.uniform1f(this.u("clarity", "u_clarity"), a.clarity);
        });
        mid = out;
      }

      // 4) netteté + masque + fondu (ping-pong "lOutA/B" pour ne pas lire/écrire la même RT)
      let shBlur = mid;
      if (a.sharpness > 0) shBlur = this.blur(mid.tex, W, H, Math.max(1.2 * scale, 0.4), "lshA", "lshB", 1);
      const brush = loc.type === "brush" ? this.brushTexture(loc, W, H)
        : loc.type === "ai" ? this.aiTexture(loc) : this.curveTex;
      const out = this.rt(parity++ % 2 ? "lOutB" : "lOutA", W, H);
      const p = loc.params || {};
      const kind = maskKind(loc.type);
      const aiK = 1 + (num(p.hardness, 0) / 100) * 12;
      this.pass("lblend", [[0, mid.tex], [1, shBlur.tex], [2, cur.tex], [3, brush]], out, W, H, () => {
        gl.uniform1i(this.u("lblend", "u_tex"), 0);
        gl.uniform1i(this.u("lblend", "u_blur"), 1);
        gl.uniform1i(this.u("lblend", "u_orig"), 2);
        gl.uniform1i(this.u("lblend", "u_brush"), 3);
        gl.uniform1f(this.u("lblend", "u_sharpen"), a.sharpness);
        gl.uniform1i(this.u("lblend", "u_kind"), kind);
        gl.uniform1f(this.u("lblend", "u_aiK"), aiK);
        gl.uniform1i(this.u("lblend", "u_invert"), loc.invert ? 1 : 0);
        gl.uniform4f(this.u("lblend", "u_lin"), num(p.x0, 0.5), num(p.y0, 0.2), num(p.x1, 0.5), num(p.y1, 0.8));
        gl.uniform4f(this.u("lblend", "u_rad"), num(p.cx, 0.5), num(p.cy, 0.5), num(p.rx, 0.25), num(p.ry, 0.25));
        gl.uniform3f(this.u("lblend", "u_rad2"), num(p.angle, 0) * Math.PI / 180, num(p.feather, 0.5), W / Math.max(H, 1));
        gl.uniform4f(this.u("lblend", "u_lr"), num(p.lo, 0.25), num(p.hi, 0.75), num(p.smooth, 0.1), 0);
        gl.uniform4f(this.u("lblend", "u_cr"), num(p.hue, 0), num(p.range, 30), num(p.smooth, 15), num(p.sat_min, 0.15));
      });
      cur = out;
    }
    return cur;
  }

  /** Dessine l'overlay rouge du masque sélectionné (touche O) sur l'image rendue → écran. */
  private maskOverlay(loc: LocalAdjust, img: RT, W: number, H: number) {
    const gl = this.gl;
    const p = loc.params || {};
    const kind = maskKind(loc.type);
    const tex = loc.type === "brush" ? this.brushTexture(loc, W, H)
      : loc.type === "ai" ? this.aiTexture(loc) : this.curveTex;
    this.pass("maskovl", [[0, img.tex], [3, tex]], null, W, H, () => {
      gl.uniform1i(this.u("maskovl", "u_tex"), 0);
      gl.uniform1i(this.u("maskovl", "u_brush"), 3);
      gl.uniform1i(this.u("maskovl", "u_kind"), kind);
      gl.uniform1f(this.u("maskovl", "u_aiK"), 1 + (num(p.hardness, 0) / 100) * 12);
      gl.uniform1i(this.u("maskovl", "u_invert"), loc.invert ? 1 : 0);
      gl.uniform4f(this.u("maskovl", "u_lin"), num(p.x0, 0.5), num(p.y0, 0.2), num(p.x1, 0.5), num(p.y1, 0.8));
      gl.uniform4f(this.u("maskovl", "u_rad"), num(p.cx, 0.5), num(p.cy, 0.5), num(p.rx, 0.25), num(p.ry, 0.25));
      gl.uniform3f(this.u("maskovl", "u_rad2"), num(p.angle, 0) * Math.PI / 180, num(p.feather, 0.5), W / Math.max(H, 1));
      gl.uniform4f(this.u("maskovl", "u_lr"), num(p.lo, 0.25), num(p.hi, 0.75), num(p.smooth, 0.1), 0);
      gl.uniform4f(this.u("maskovl", "u_cr"), num(p.hue, 0), num(p.range, 30), num(p.smooth, 15), num(p.sat_min, 0.15));
    });
  }

  render(e: EditState, skipCrop = false, showClip = false, maskOverlayId: string | null = null) {
    const gl = this.gl;
    if (!this.workW) return;
    const ovlLoc = maskOverlayId ? e.locals.find((l) => l.id === maskOverlayId) ?? null : null;

    // 0) géométrie (pré-pass mis en cache) : le reste tourne sur l'image recadrée.
    const geo = this.applyGeometry(e.geometry, skipCrop);
    const W = geo.w, H = geo.h, maxd = Math.max(W, H);

    // 0bis) réduction de bruit IA : mélange base bruitée ↔ base débruitée (même géométrie).
    //       Quasi gratuit ; coût nul quand inactif ou base débruitée pas encore chargée.
    let inputTex = geo.tex;
    if (e.detail.nr_ai > 0 && this.denoiseLoaded && this.denoiseTex) {
      const geoDn = this.applyGeometry(e.geometry, skipCrop, this.denoiseTex, "geoAI", this.geoAI);
      const blended = this.rt("nrai", W, H);
      this.pass("blend", [[0, geo.tex], [1, geoDn.tex]], blended, W, H, () => {
        gl.uniform1i(this.u("blend", "u_tex"), 0);
        gl.uniform1i(this.u("blend", "u_tex2"), 1);
        gl.uniform1f(this.u("blend", "u_amt"), e.detail.nr_ai / 100);
      });
      inputTex = blended.tex;
    }
    // scale = ratio rendu/pleine-résolution, calculé sur la taille NON recadrée (comme le Python)
    const scale = Math.max(this.workW, this.workH) / this.fullLong;
    const cv = gl.canvas as HTMLCanvasElement;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }

    // courbe : reconstruction de la LUT seulement quand une courbe (maître ou canal) change
    const ck = JSON.stringify(e.curve);
    if (ck !== this.lastCurve) {
      this.lastCurve = ck;
      const lut = buildCurveTexture(e.curve);
      this.hasCurve = !!lut;
      if (lut) {
        gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lut.length / 4, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
      }
    }

    // 1) WB + exposition → ppA
    const ppA = this.rt("ppA", W, H);
    const [wr, wg, wb] = wbGains(e.wb.temp, e.wb.tint);
    this.pass("linear", [[0, inputTex]], ppA, W, H, () => {
      gl.uniform1i(this.u("linear", "u_tex"), 0);
      gl.uniform3f(this.u("linear", "u_wb"), wr, wg, wb);
      gl.uniform1f(this.u("linear", "u_expo"), e.tone.exposure);
    });

    // 2) masque de luminance pour HL/ombres
    const hasHL = e.tone.highlights !== 0 || e.tone.shadows !== 0;
    let hlBlur = ppA;
    if (hasHL) hlBlur = this.blur(ppA.tex, W, H, maxd * 0.02, "hlA", "hlB", 4);

    // 3) HL/ombres + tons + couleur → ppB
    const ppB = this.rt("ppB", W, H);
    const hsl = new Float32Array(24); let hasHsl = 0;
    HSL_BANDS.forEach((band, i) => {
      const v = e.hsl[band]; hsl[i * 3] = v.h; hsl[i * 3 + 1] = v.s; hsl[i * 3 + 2] = v.l;
      if (v.h || v.s || v.l) hasHsl = 1;
    });
    this.pass("tone", [[0, ppA.tex], [1, this.curveTex], [2, hlBlur.tex]], ppB, W, H, () => {
      gl.uniform1i(this.u("tone", "u_tex"), 0);
      gl.uniform1i(this.u("tone", "u_curve"), 1);
      gl.uniform1i(this.u("tone", "u_lumaBlur"), 2);
      gl.uniform1i(this.u("tone", "u_hasHL"), hasHL ? 1 : 0);
      gl.uniform1f(this.u("tone", "u_hl"), e.tone.highlights);
      gl.uniform1f(this.u("tone", "u_sh"), e.tone.shadows);
      gl.uniform1f(this.u("tone", "u_whites"), e.tone.whites);
      gl.uniform1f(this.u("tone", "u_blacks"), e.tone.blacks);
      gl.uniform1f(this.u("tone", "u_contrast"), e.tone.contrast);
      gl.uniform1i(this.u("tone", "u_hasCurve"), this.hasCurve ? 1 : 0);
      gl.uniform1i(this.u("tone", "u_hasHsl"), hasHsl);
      gl.uniform3fv(this.u("tone", "u_hsl"), hsl);
      gl.uniform1f(this.u("tone", "u_vibrance"), e.presence.vibrance);
      gl.uniform1f(this.u("tone", "u_saturation"), e.presence.saturation);
    });
    let cur = ppB;

    // 4) clarté → ppA
    if (e.presence.clarity !== 0) {
      const clBlur = this.blur(cur.tex, W, H, Math.max(8, maxd * 0.012), "clA", "clB", 4);
      const out = this.rt("ppA", W, H);
      this.pass("clarity", [[0, cur.tex], [1, clBlur.tex]], out, W, H, () => {
        gl.uniform1i(this.u("clarity", "u_tex"), 0);
        gl.uniform1i(this.u("clarity", "u_lumaBlur"), 1);
        gl.uniform1f(this.u("clarity", "u_clarity"), e.presence.clarity);
      });
      cur = out;
    }

    // 5) dehaze (dark channel prior) — après clarté, comme le pipeline Python
    if (e.presence.dehaze !== 0) {
      const out = this.rt("dz", W, H);
      if (e.presence.dehaze > 0) {
        const ds = 4, dw = Math.max(1, Math.round(W / ds)), dh = Math.max(1, Math.round(H / ds));
        const dcA = this.rt("dcA", dw, dh);
        this.pass("dcval", [[0, cur.tex]], dcA, dw, dh, () => {
          gl.uniform1i(this.u("dcval", "u_tex"), 0);
          gl.uniform2f(this.u("dcval", "u_texel"), 1 / dw, 1 / dh);
        });
        const tBlur = this.blur(dcA.tex, dw, dh, Math.max(maxd * 0.01 / ds, 0.6), "dcbA", "dcbB", 1);
        const amax = this.rt("amax", 1, 1);
        this.pass("reducemax", [[0, dcA.tex]], amax, 1, 1, () => gl.uniform1i(this.u("reducemax", "u_tex"), 0));
        this.pass("dehaze", [[0, cur.tex], [1, tBlur.tex], [2, amax.tex]], out, W, H, () => {
          gl.uniform1i(this.u("dehaze", "u_tex"), 0);
          gl.uniform1i(this.u("dehaze", "u_dark"), 1);
          gl.uniform1i(this.u("dehaze", "u_amax"), 2);
          gl.uniform1f(this.u("dehaze", "u_dehaze"), e.presence.dehaze);
        });
      } else {
        this.pass("dehaze", [[0, cur.tex]], out, W, H, () => {
          gl.uniform1i(this.u("dehaze", "u_tex"), 0);
          gl.uniform1f(this.u("dehaze", "u_dehaze"), e.presence.dehaze);
        });
      }
      cur = out;
    }

    // 6) retouches locales (entre dehaze et NR, comme le pipeline Python)
    if (e.locals.length) cur = this.renderLocals(e, W, H, maxd, scale, cur);

    // 7) réduction de bruit — chroma (lissage Cr/Cb) puis luminance (bilatéral)
    const scaleNR = Math.max(scale, 0.25);
    if (e.detail.nr_color > 0) {
      const ycc = this.rt("ycc", W, H);
      this.pass("ycc", [[0, cur.tex]], ycc, W, H, () => gl.uniform1i(this.u("ycc", "u_tex"), 0));
      const sigma = (1 + 7 * e.detail.nr_color / 100) * scaleNR;
      const yccBlur = this.blur(ycc.tex, W, H, sigma, "ncbA", "ncbB", 1);
      const out = this.rt("nc", W, H);
      this.pass("chroma", [[0, ycc.tex], [1, yccBlur.tex]], out, W, H, () => {
        gl.uniform1i(this.u("chroma", "u_tex"), 0);
        gl.uniform1i(this.u("chroma", "u_blur"), 1);
      });
      cur = out;
    }
    if (e.detail.nr_luma > 0) {
      const amt = e.detail.nr_luma / 100;
      const sigmaS = 2 + 5 * amt * scaleNR, sigmaC = Math.max(0.03 + 0.12 * amt, 1e-3);
      const radius = Math.min(Math.max(Math.ceil(2 * sigmaS), 1), MAX_TAPS - 1);
      const tmp = this.rt("nlH", W, H);
      const setBil = (dirX: number, dirY: number, doBlend: number) => () => {
        gl.uniform1i(this.u("bilateral", "u_tex"), 0);
        gl.uniform2f(this.u("bilateral", "u_dir"), dirX, dirY);
        gl.uniform1i(this.u("bilateral", "u_radius"), radius);
        gl.uniform1f(this.u("bilateral", "u_sigmaS"), sigmaS);
        gl.uniform1f(this.u("bilateral", "u_sigmaC"), sigmaC);
        gl.uniform1i(this.u("bilateral", "u_doBlend"), doBlend);
        if (doBlend) { gl.uniform1i(this.u("bilateral", "u_orig"), 1); gl.uniform1f(this.u("bilateral", "u_blend"), Math.min(amt * 1.4, 1.0)); }
      };
      this.pass("bilateral", [[0, cur.tex]], tmp, W, H, setBil(1 / W, 0, 0));
      const out = this.rt("nl", W, H);
      this.pass("bilateral", [[0, tmp.tex], [1, cur.tex]], out, W, H, setBil(0, 1 / H, 1));
      cur = out;
    }

    // 7bis) défrange (désaturation des franges pourpres/vertes sur les bords)
    if (e.detail.defringe_purple > 0 || e.detail.defringe_green > 0) {
      const dfBlur = this.blur(cur.tex, W, H, Math.max(1.5 * scale, 0.6), "dfA", "dfB", 1);
      const out = this.rt("df", W, H);
      this.pass("defringe", [[0, cur.tex], [1, dfBlur.tex]], out, W, H, () => {
        gl.uniform1i(this.u("defringe", "u_tex"), 0);
        gl.uniform1i(this.u("defringe", "u_blur"), 1);
        gl.uniform1f(this.u("defringe", "u_purple"), e.detail.defringe_purple);
        gl.uniform1f(this.u("defringe", "u_green"), e.detail.defringe_green);
      });
      cur = out;
    }

    // 8) netteté (petit flou pleine résolution) → écran, + vignettage
    const sharpen = e.detail.sharpen_amount;
    let sharpBlur = cur;
    if (sharpen > 0) {
      const sigma = Math.max(e.detail.sharpen_radius * scale, 0.4);
      sharpBlur = this.blur(cur.tex, W, H, sigma, "shA", "shB", 1);
    }
    // overlay actif → la passe finale écrit dans une RT, puis l'overlay rouge va à l'écran
    const finOut = ovlLoc ? this.rt("fin", W, H) : null;
    this.pass("final", [[0, cur.tex], [1, sharpBlur.tex]], finOut, W, H, () => {
      gl.uniform1i(this.u("final", "u_tex"), 0);
      gl.uniform1i(this.u("final", "u_blur"), 1);
      gl.uniform1f(this.u("final", "u_sharpen"), sharpen);
      gl.uniform1f(this.u("final", "u_vignette"), e.effects.vignette);
      gl.uniform1i(this.u("final", "u_showClip"), showClip ? 1 : 0);
    });
    if (ovlLoc && finOut) this.maskOverlay(ovlLoc, finOut, W, H);
    gl.finish();

    // Force la présentation du canvas : sur certains pilotes le drawing buffer
    // n'est pas recomposé sur la page sans une lecture (readPixels) ou un rAF.
    // Quasi gratuit ici (1 px, après gl.finish()), et indispensable pour que
    // l'aperçu s'actualise à chaque édition.
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.presentPx);
  }
}

function num(v: any, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function maskKind(type: string): number {
  return type === "linear" ? 0 : type === "radial" ? 1 : type === "brush" ? 2
    : type === "ai" ? 3 : type === "lumrange" ? 4 : 5;
}

/** Plus grand rectangle de même aspect inscrit dans l'image redressée (port de _largest_rotated_rect). */
function largestRotatedRect(w: number, h: number, angleRad: number): [number, number] {
  if (w <= 0 || h <= 0) return [0, 0];
  const s = Math.abs(Math.sin(angleRad)), c = Math.abs(Math.cos(angleRad));
  const k = Math.min(w / (w * c + h * s), h / (w * s + h * c));
  return [w * k, h * k];
}

export function wbGains(temp: number, tint: number): [number, number, number] {
  const t = temp / 100, g = tint / 100;
  return [2 ** (0.5 * t + 0.15 * g), 2 ** (-0.3 * g), 2 ** (-0.5 * t + 0.15 * g)];
}
