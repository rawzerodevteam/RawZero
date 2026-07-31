/**
 * Sources GLSL des passes du pipeline GPU (WebGL2) — extrait de `pipeline.ts` (TODO N11 : ce
 * bloc de constantes de données pures, sans dépendance sur l'état de `GpuPipeline`, était la
 * moitié du fichier). Aucune logique déplacée, juste les chaînes de shader et leurs uniforms.
 */

export const VERSION = "#version 300 es\n";

export const VERT = VERSION + `
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// Fonctions communes à tous les fragments
export const PRELUDE = `
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
export const F_LINEAR = VERSION + PRELUDE + `
uniform vec3 u_wb; uniform float u_expo;
void main(){
  vec3 c = texture(u_tex, v_uv).rgb;
  o = vec4(l2s(s2l(c) * u_wb * exp2(u_expo)), 1.);
}`;

// 2) downscale + luma (pour les masques de luminance)
export const F_LUMA = VERSION + PRELUDE + `
void main(){ float l = luma(texture(u_tex, v_uv).rgb); o = vec4(l, l, l, 1.); }`;

// 3) flou gaussien séparable (1D)
export const MAX_TAPS = 24;
export const F_BLUR = VERSION + PRELUDE + `
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
export const F_TONE = VERSION + PRELUDE + `
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
export const F_CLARITY = VERSION + PRELUDE + `
uniform sampler2D u_lumaBlur; uniform float u_clarity;
void main(){
  vec3 c = texture(u_tex, v_uv).rgb;
  float l = luma(c);
  float detail = l - texture(u_lumaBlur, v_uv).r;
  float mid = 1. - pow(abs(2.*clamp(l,0.,1.)-1.), 2.);
  o = vec4(c + (u_clarity/100.*0.9*detail*mid), 1.);
}`;

// 5bis) défrange : désature les franges pourpres/vertes sur les bords (aberration chromatique)
export const F_DEFRINGE = VERSION + PRELUDE + `
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

// 6) netteté (masque flou) + vignettage + grain — passe finale (rendu écran)
export const F_FINAL = VERSION + PRELUDE + `
uniform sampler2D u_blur; uniform float u_sharpen; uniform float u_vignette; uniform int u_showClip;
uniform float u_grain; uniform float u_grainSeed;
float grainHash(vec2 p, float seed){
  p = fract(p * vec2(0.1031, 0.1030) + seed);
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}
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
  if(u_grain>0.){
    // moyenne de 4 tirages uniformes (approx. gaussienne, Irwin-Hall) ~ N(0,1)
    float n = 0.;
    for(int i=0;i<4;i++) n += grainHash(gl_FragCoord.xy + float(i)*17.3, u_grainSeed + float(i)*7.1);
    n = (n - 2.0) * 1.73;
    c += n * (u_grain/100. * 0.05);
  }
  c = clamp(c, 0., 1.);
  if(u_showClip==1){                                 // alertes d'écrêtage (mêmes seuils/couleurs que le CPU)
    if(all(greaterThanEqual(c, vec3(0.98)))) c = vec3(235., 40., 40.)/255.;
    else if(all(lessThanEqual(c, vec3(0.016)))) c = vec3(50., 90., 235.)/255.;
  }
  o = vec4(c, 1.);
}`;

// 7) dark channel érodé (.r) + canal max (.g) — base du dehaze (résolution réduite)
export const F_DCVAL = VERSION + PRELUDE + `
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
export const F_REDUCE_MAX = VERSION + PRELUDE + `
void main(){
  const int N = 12;
  float m = 0.0;
  for(int y=0;y<N;y++) for(int x=0;x<N;x++)
    m = max(m, texture(u_tex, (vec2(float(x),float(y))+0.5)/float(N)).g);
  o = vec4(m, m, m, 1.0);
}`;

// 9) dehaze (dark channel prior simplifié) — fidèle à _apply_dehaze
export const F_DEHAZE = VERSION + PRELUDE + `
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
export const F_YCC = VERSION + PRELUDE + `
void main(){
  vec3 c = clamp(texture(u_tex, v_uv).rgb, 0., 1.);
  float Y = dot(c, vec3(0.299, 0.587, 0.114));
  o = vec4(Y, (c.r - Y)*0.713 + 0.5, (c.b - Y)*0.564 + 0.5, 1.0);
}`;

// 11) recombine Y (net) + Cr/Cb floutés → RGB (lissage chroma)
export const F_CHROMA = VERSION + PRELUDE + `
uniform sampler2D u_blur;
void main(){
  float Y = texture(u_tex, v_uv).r;
  vec2 cc = texture(u_blur, v_uv).gb - 0.5;
  o = vec4(Y + 1.403*cc.x, Y - 0.714*cc.x - 0.344*cc.y, Y + 1.773*cc.y, 1.0);
}`;

// 12) bilatéral séparable (NR luminance, préserve les bords) + fondu sur l'original
export const F_BILATERAL = VERSION + PRELUDE + `
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
export const MASK_GLSL = `
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
    if(hi < lo){ float t = lo; lo = hi; hi = t; }
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

export const F_LBLEND = VERSION + PRELUDE + MASK_GLSL + `
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
export const F_MASKOVL = VERSION + PRELUDE + MASK_GLSL + `
void main(){
  vec3 img = texture(u_tex, v_uv).rgb;
  float m = computeMask(vec2(v_uv.x, 1.0 - v_uv.y), img);
  o = vec4(mix(img, vec3(1.0, 0.15, 0.15), m * 0.6), 1.0);
}`;

// 14) mélange de deux textures (base bruitée ↔ base débruitée IA) — réduction de bruit IA.
export const F_BLEND = VERSION + PRELUDE + `
uniform sampler2D u_tex2; uniform float u_amt;
void main(){ o = vec4(mix(texture(u_tex,v_uv).rgb, texture(u_tex2,v_uv).rgb, u_amt), 1.); }`;

// 0) géométrie (pré-pass sur la base) — mapping INVERSE output→base, fidèle à apply_geometry.
//    Coords « sample » y vers le haut (= v_uv ; la base est uploadée FLIP_Y). Ordre inverse :
//    undo crop → undo redressement+auto-crop → undo miroirs → undo rotation 90°.
export const F_GEOM = VERSION + PRELUDE + `
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
