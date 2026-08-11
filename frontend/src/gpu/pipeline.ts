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
import {
  VERT, MAX_TAPS, F_LINEAR, F_LUMA, F_BLUR, F_TONE, F_CLARITY, F_DEFRINGE, F_FINAL,
  F_DCVAL, F_REDUCE_MAX, F_DEHAZE, F_YCC, F_CHROMA, F_BILATERAL, F_LBLEND, F_MASKOVL,
  F_BLEND, F_GEOM, F_INPAINTBLEND,
} from "./shaders";

const ZERO_HSL = new Float32Array(24);

const COPY_W = new Float32Array(MAX_TAPS); COPY_W[0] = 1; // poids neutre (copie/downscale)

export function gaussianWeights(sigma: number): { weights: Float32Array; radius: number } {
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
  private brushRawTex = new Map<string, WebGLTexture>(); // traits non floutés (source du flou GPU), par id
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
  private quadBuf: WebGLBuffer | null = null;
  workW = 0;
  workH = 0;
  fullLong = 1;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const floatRender = gl.getExtension("EXT_color_buffer_float");
    this.colorType = floatRender ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    this.colorInternal = floatRender ? gl.RGBA16F : gl.RGBA8;

    const buf = gl.createBuffer();
    this.quadBuf = buf;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const sources: Record<string, string> = {
      linear: F_LINEAR, luma: F_LUMA, blur: F_BLUR, tone: F_TONE, clarity: F_CLARITY, final: F_FINAL,
      dcval: F_DCVAL, reducemax: F_REDUCE_MAX, dehaze: F_DEHAZE, ycc: F_YCC, chroma: F_CHROMA,
      bilateral: F_BILATERAL, lblend: F_LBLEND, geom: F_GEOM, maskovl: F_MASKOVL, blend: F_BLEND,
      defringe: F_DEFRINGE, inpaintblend: F_INPAINTBLEND,
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

  /** Libère toutes les ressources GL allouées (programmes/textures/FBO/buffer). À appeler avant
   *  d'abandonner l'instance : le contexte WebGL du canvas persiste tant que l'aperçu GPU est
   *  réactivé/désactivé sans démonter le composant, donc chaque `new GpuPipeline(gl)` réutilise
   *  le même contexte et fuit sinon (programmes/textures/FBO jamais détruits). */
  dispose(): void {
    const gl = this.gl;
    for (const p of Object.values(this.progs)) gl.deleteProgram(p);
    this.progs = {};
    for (const { tex, fbo } of this.rts.values()) { gl.deleteTexture(tex); gl.deleteFramebuffer(fbo); }
    this.rts.clear();
    gl.deleteTexture(this.baseTex);
    gl.deleteTexture(this.curveTex);
    if (this.denoiseTex) gl.deleteTexture(this.denoiseTex);
    this.clearMaskTextures();
    if (this.quadBuf) gl.deleteBuffer(this.quadBuf);
    this.quadBuf = null;
  }

  /** Détruit les textures des masques pinceau/IA (appelé au changement de photo et à `dispose`). */
  private clearMaskTextures(): void {
    const gl = this.gl;
    // brushTex.tex n'est pas toujours possédé ici : avec feather>0 c'est la texture d'une RT du pool
    // `this.rts` (nettoyée par `dispose` via ce pool) — ne la supprimer que via brushRawTex, sinon la
    // RT partagerait un handle supprimé et casserait la réutilisation par clé au prochain flou.
    this.brushTex.clear();
    for (const tex of this.brushRawTex.values()) gl.deleteTexture(tex);
    this.brushRawTex.clear();
    for (const { tex } of this.aiTex.values()) gl.deleteTexture(tex);
    this.aiTex.clear();
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
    this.clearMaskTextures();                 // idem masques pinceau/IA
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
   *  Reproduit masks._brush_mask : cercles/lignes par trait (effacement = noir), puis flou gaussien (feather).
   *  Le flou passe par le même flou séparable GPU que le reste du pipeline (`this.blur`) plutôt que le
   *  `filter: blur()` de Canvas2D — évite l'approximation dépendante du navigateur (parfois par boîtes
   *  glissantes) et rapproche le rendu de `cv2.GaussianBlur` côté serveur. */
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
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    const longEdge = Math.max(W, H);
    let maxRadius = 1;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const st of strokes) {
      const pts: any[] = Array.isArray(st.points) ? st.points : [];
      if (!pts.length) continue;
      const radius = Math.max(Number(st.size ?? 0.05) * longEdge * 0.5, 1);
      maxRadius = Math.max(maxRadius, radius);
      const v = st.erase ? 0 : 255;
      ctx.fillStyle = ctx.strokeStyle = `rgb(${v},${v},${v})`;
      const P = pts.map((p) => [Number(p[0]) * (W - 1), Number(p[1]) * (H - 1)] as [number, number]);
      if (P.length > 1) {
        ctx.lineWidth = Math.max(2 * radius, 1);
        ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]);
        for (let i = 1; i < P.length; i++) ctx.lineTo(P[i][0], P[i][1]);
        ctx.stroke();
      }
      for (const [x, y] of P) { ctx.beginPath(); ctx.arc(x, y, radius, 0, 2 * Math.PI); ctx.fill(); }
    }

    const rawTex = this.brushRawTex.get(loc.id) ?? this.newTex();
    this.brushRawTex.set(loc.id, rawTex);
    gl.bindTexture(gl.TEXTURE_2D, rawTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);

    let tex = rawTex;
    if (feather > 0) {
      const sigmaPx = Math.max(maxRadius * feather * 0.6, 0.5);
      tex = this.blur(rawTex, W, H, sigmaPx, `brushA_${loc.id}`, `brushB_${loc.id}`, 1).tex;
    }
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
      wrwh = [Wr / rw, Hr / rh];
      // apply_geometry (backend/app/pipeline.py) tronque le rectangle inscrit en pixels entiers
      // (`int(wr)`/`int(hr)`) avant de recadrer par-dessus — tronquer ici aussi pour que le crop
      // ci-dessous parte des mêmes dimensions entières que côté serveur (sinon écart de ±1px).
      sw = Math.max(Math.trunc(Wr), 1); sh = Math.max(Math.trunc(Hr), 1);
    }
    // Même convention que apply_geometry (backend/app/pipeline.py:171-175) : troncature des bornes
    // en pixels plutôt qu'arrondi de la largeur/hauteur — un `Math.round` indépendant sur gw/gh peut
    // différer de ±1px de `x1 - x0` tronqué, désalignant les masques locaux (coordonnées normalisées
    // sur l'image recadrée) entre l'aperçu GPU et le rendu serveur.
    const x0 = Math.trunc(Math.min(Math.max(c.x, 0), 0.98) * sw);
    const y0 = Math.trunc(Math.min(Math.max(c.y, 0), 0.98) * sh);
    const x1 = Math.trunc(Math.min(Math.max(c.x + c.w, 0.02), 1) * sw);
    const y1 = Math.trunc(Math.min(Math.max(c.y + c.h, 0.02), 1) * sh);
    const gw = Math.max(x1 - x0, 8), gh = Math.max(y1 - y0, 8);
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
      if (loc.type === "inpaint") {   // correcteur de taches IA : pas de mini-pipeline de réglages
        const p = loc.params || {};
        const ref = String(p.ref ?? "");
        if (ref) {
          const rect: number[] = Array.isArray(p.rect) ? p.rect : [0, 0, 1, 1];
          const patch = this.aiTexture(loc);              // patch RGB précalculé (même cache que les masques IA)
          const brush = this.brushTexture(loc, W, H);      // forme peinte (mêmes traits que le masque "brush")
          const out = this.rt(parity++ % 2 ? "lOutB" : "lOutA", W, H);
          this.pass("inpaintblend", [[0, cur.tex], [1, patch], [2, brush]], out, W, H, () => {
            gl.uniform1i(this.u("inpaintblend", "u_tex"), 0);
            gl.uniform1i(this.u("inpaintblend", "u_patch"), 1);
            gl.uniform1i(this.u("inpaintblend", "u_brush"), 2);
            gl.uniform1i(this.u("inpaintblend", "u_kind"), maskKind("inpaint"));
            gl.uniform1i(this.u("inpaintblend", "u_invert"), loc.invert ? 1 : 0);
            gl.uniform4f(this.u("inpaintblend", "u_rect"), rect[0], rect[1], rect[2], rect[3]);
            gl.uniform1f(this.u("inpaintblend", "u_opacity"), num(p.opacity, 1));
          });
          cur = out;
        }
        continue;
      }
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
        : (loc.type === "ai" || loc.type === "depthrange") ? this.aiTexture(loc) : this.curveTex;
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
        gl.uniform4f(this.u("lblend", "u_lr"), num(p.lo ?? p.near, 0.25), num(p.hi ?? p.far, 0.75), num(p.smooth, 0.1), 0);
        gl.uniform4f(this.u("lblend", "u_cr"), num(p.hue, 0), num(p.range, 30), num(p.smooth, 15), num(p.sat_min, 0.15));
        gl.uniform1f(this.u("lblend", "u_lightFalloff"), num(p.falloff, 1.8));
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
    const tex = (loc.type === "brush" || loc.type === "inpaint") ? this.brushTexture(loc, W, H)
      : (loc.type === "ai" || loc.type === "depthrange") ? this.aiTexture(loc) : this.curveTex;
    this.pass("maskovl", [[0, img.tex], [3, tex]], null, W, H, () => {
      gl.uniform1i(this.u("maskovl", "u_tex"), 0);
      gl.uniform1i(this.u("maskovl", "u_brush"), 3);
      gl.uniform1i(this.u("maskovl", "u_kind"), kind);
      gl.uniform1f(this.u("maskovl", "u_aiK"), 1 + (num(p.hardness, 0) / 100) * 12);
      gl.uniform1i(this.u("maskovl", "u_invert"), loc.invert ? 1 : 0);
      gl.uniform4f(this.u("maskovl", "u_lin"), num(p.x0, 0.5), num(p.y0, 0.2), num(p.x1, 0.5), num(p.y1, 0.8));
      gl.uniform4f(this.u("maskovl", "u_rad"), num(p.cx, 0.5), num(p.cy, 0.5), num(p.rx, 0.25), num(p.ry, 0.25));
      gl.uniform3f(this.u("maskovl", "u_rad2"), num(p.angle, 0) * Math.PI / 180, num(p.feather, 0.5), W / Math.max(H, 1));
      gl.uniform4f(this.u("maskovl", "u_lr"), num(p.lo ?? p.near, 0.25), num(p.hi ?? p.far, 0.75), num(p.smooth, 0.1), 0);
      gl.uniform4f(this.u("maskovl", "u_cr"), num(p.hue, 0), num(p.range, 30), num(p.smooth, 15), num(p.sat_min, 0.15));
      gl.uniform1f(this.u("maskovl", "u_lightFalloff"), num(p.falloff, 1.8));
    });
  }

  render(e: EditState, skipCrop = false, showClip = false, maskOverlayId: string | null = null, quality = 1, seed = 0) {
    const gl = this.gl;
    if (!this.workW) return;
    const ovlLoc = maskOverlayId ? e.locals.find((l) => l.id === maskOverlayId) ?? null : null;

    // 0) géométrie (pré-pass mis en cache, plein résolution) : le reste tourne sur l'image recadrée.
    const geo = this.applyGeometry(e.geometry, skipCrop);
    // quality < 1 (pendant un drag de slider) : on rend TOUT le pipeline aval à résolution réduite
    // (downscale en samplant la géométrie pleine réso). Gain quadratique sur les passes plein écran ;
    // l'aperçu est un peu plus doux pendant le drag, net au relâchement (quality=1). N'affecte PAS
    // l'export (Python, pleine réso) ni la parité. La géométrie cachée reste pleine réso.
    const q = Math.min(Math.max(quality, 0.1), 1);
    const W = Math.max(1, Math.round(geo.w * q)), H = Math.max(1, Math.round(geo.h * q));
    const maxd = Math.max(W, H);

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
    // scale = ratio rendu/pleine-résolution, calculé sur la taille NON recadrée (comme le Python).
    // ×q : à résolution réduite les rayons (netteté/NR) rétrécissent proportionnellement.
    const scale = (Math.max(this.workW, this.workH) / this.fullLong) * q;
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
      gl.uniform1f(this.u("final", "u_grain"), e.effects.grain);
      gl.uniform1f(this.u("final", "u_grainSeed"), (seed % 1000) * 0.618);
      gl.uniform1i(this.u("final", "u_showClip"), showClip ? 1 : 0);
    });
    if (ovlLoc && finOut) this.maskOverlay(ovlLoc, finOut, W, H);
    // NE PAS appeler gl.finish()/readPixels ici : ils BLOQUENT le thread principal jusqu'à la
    // fin de TOUTES les passes GPU (des dizaines de ms à 1600 px) → le slider lague en mode GPU.
    // render() est désormais appelé dans un requestAnimationFrame (useGpuPreview), qui garantit
    // la recomposition du canvas après la frame. Un simple flush (non bloquant) suffit à pousser
    // les commandes vers le GPU.
    gl.flush();
  }
}

function num(v: any, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function maskKind(type: string): number {
  return type === "linear" ? 0 : type === "radial" ? 1 : (type === "brush" || type === "inpaint") ? 2
    : type === "ai" ? 3 : type === "lumrange" ? 4 : type === "light" ? 6 : type === "depthrange" ? 7 : 5;
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
