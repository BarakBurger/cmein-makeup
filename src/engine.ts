/**
 * On-device makeup: find the face, read the skin tone, and paint each product onto the photo.
 *
 * Everything here runs in the browser. The face is located by MediaPipe's Face Landmarker (478
 * points, loaded from the CDN the first time it is needed), and every product is a colour laid over the original pixels through a soft mask
 * built from those points. Nothing is redrawn, so the face underneath is the visitor's own: the
 * shape of the lips, eyes and nose cannot change except where a product says so (fuller lips, up to
 * 7%, is the one deliberate exception).
 *
 * Landmarks are kept normalised (0..1) so one detection serves the small preview and the full-size
 * download alike.
 */

export type Pt = { x: number; y: number };

// ---------------------------------------------------------------------------------------------
// The face model

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';

let landmarker: Promise<any> | null = null;

/** Load the landmarker once per page. A failure is not cached, so a second try can succeed. */
export function loadLandmarker(): Promise<any> {
  if (landmarker) return landmarker;
  landmarker = (async () => {
    // The hints keep bundlers from trying to resolve a URL at build time; the browser loads it.
    const vision: any = await import(/* @vite-ignore */ /* webpackIgnore: true */ CDN);
    const fileset = await vision.FilesetResolver.forVisionTasks(CDN + '/wasm');
    return vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL },
      runningMode: 'IMAGE',
      // Up to four, so the largest can be chosen in a scene with other people in it.
      numFaces: 4,
      minFaceDetectionConfidence: 0.35,
      minFacePresenceConfidence: 0.35,
    });
  })();
  landmarker.catch(() => { landmarker = null; });
  return landmarker;
}

export type Detection =
  | { ok: true; points: Pt[] }
  | { ok: false; reason: 'none' | 'several' | 'small' };

type Img = CanvasImageSource & { width: number; height: number };

/** Faces in one picture, largest first, each with its width in that picture's pixels. */
function facesIn(lm: any, image: Img): { points: Pt[]; width: number }[] {
  const res = lm.detect(image);
  return (res?.faceLandmarks ?? [])
    .map((f: any[]) => {
      const points = f.map(p => ({ x: p.x, y: p.y }));
      const xs = points.map((p: Pt) => p.x * image.width);
      return { points, width: Math.max(...xs) - Math.min(...xs) };
    })
    .sort((a: { width: number }, b: { width: number }) => b.width - a.width);
}

/**
 * The parts of a photo to look in again when the whole of it showed no face. The landmarker is
 * built for faces near the camera; in a full-length photo (a Studio scene, a suit on steps) the face
 * is a few dozen pixels high and it misses it. Enlarged, the upper part of the frame, where a
 * standing person's face is, is found.
 */
const RETRY_CROPS = [
  { x: 0, y: 0, w: 1, h: 0.55 },
  { x: 0.15, y: 0, w: 0.7, h: 0.4 },
  { x: 0.25, y: 0.03, w: 0.5, h: 0.28 },
];

/**
 * Find the face to make up.
 *
 * Several faces is not a refusal: in a scene the person the photo is of is the largest face, and
 * the rest are passers-by. Only two faces of about the same size are ambiguous enough to refuse.
 */
export async function detectFace(image: Img): Promise<Detection> {
  const lm = await loadLandmarker();
  let faces = facesIn(lm, image);
  let points: Pt[] | null = null;
  let width = 0;

  if (faces.length === 0) {
    for (const c of RETRY_CROPS) {
      const k = Math.max(1, 1024 / Math.max(c.w * image.width, c.h * image.height));
      const crop = document.createElement('canvas');
      crop.width = Math.round(c.w * image.width * k); crop.height = Math.round(c.h * image.height * k);
      crop.getContext('2d')!.drawImage(image, c.x * image.width, c.y * image.height, c.w * image.width, c.h * image.height, 0, 0, crop.width, crop.height);
      const found = facesIn(lm, crop);
      if (!found.length) continue;
      // Back into the coordinates of the whole photo.
      points = found[0].points.map(p => ({ x: c.x + p.x * c.w, y: c.y + p.y * c.h }));
      width = found[0].width / k;
      faces = found;
      break;
    }
    if (!points) return { ok: false, reason: 'none' };
  } else {
    if (faces.length > 1 && faces[1].width > faces[0].width * 0.85) return { ok: false, reason: 'several' };
    points = faces[0].points;
    width = faces[0].width;
  }

  // What matters is how many pixels the face has, not how much of the frame it fills. Below about
  // 50 px across, the lips and lids are a few pixels each and nothing can be placed on them.
  if (width < 50) return { ok: false, reason: 'small' };
  return { ok: true, points };
}

// ---------------------------------------------------------------------------------------------
// Landmark groups (MediaPipe face mesh indices). "Right" and "left" are the person's own, so on a
// face looking at the camera the right eye is on the left of the photo.

const LIPS_OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
const LIPS_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176,
  149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

type EyeDef = { upper: number[]; lower: number[]; outer: number; inner: number; browUpper: number[]; browLower: number[] };
const EYES: Record<'right' | 'left', EyeDef> = {
  right: {
    upper: [33, 246, 161, 160, 159, 158, 157, 173, 133], lower: [133, 155, 154, 153, 145, 144, 163, 7, 33],
    outer: 33, inner: 133, browUpper: [70, 63, 105, 66, 107], browLower: [46, 53, 52, 65, 55],
  },
  left: {
    upper: [263, 466, 388, 387, 386, 385, 384, 398, 362], lower: [362, 382, 381, 380, 374, 373, 390, 249, 263],
    outer: 263, inner: 362, browUpper: [300, 293, 334, 296, 336], browLower: [276, 283, 282, 295, 285],
  },
};

/** Where the skin colour is read: forehead, between the brows, both cheeks, both upper cheeks. */
const SKIN_SAMPLES = [151, 9, 50, 280, 205, 425, 117, 346];

// ---------------------------------------------------------------------------------------------
// Skin tone

/** Ten tones from very light to very deep. Foundation, concealer and contour are derived from these. */
export const SKIN_TONES: { name: string; hex: string }[] = [
  { name: 'Porcelain', hex: '#F6E3D4' }, { name: 'Ivory', hex: '#EFD0BA' }, { name: 'Light beige', hex: '#E6BFA1' },
  { name: 'Warm sand', hex: '#D9A882' }, { name: 'Honey', hex: '#C98F6A' }, { name: 'Caramel', hex: '#B27752' },
  { name: 'Bronze', hex: '#956043' }, { name: 'Chestnut', hex: '#774A33' }, { name: 'Espresso', hex: '#5A3726' },
  { name: 'Deep ebony', hex: '#3D2519' },
];

type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export function rgbToHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** Linear blend of two colours, t from 0 (a) to 1 (b). */
export function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

/** sRGB to CIELAB, so "nearest tone" means nearest to the eye rather than nearest in RGB numbers. */
function lab([r, g, b]: RGB): [number, number, number] {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

/**
 * Read the skin from the photo and pick the nearest of the ten tones.
 *
 * Each sample is the median of a small patch rather than one pixel, so a freckle, a pore or a
 * reflection does not decide the tone, and the brightest and darkest samples are dropped before
 * averaging, because one cheek is usually in more light than the other.
 */
export function detectSkinTone(image: CanvasImageSource & { width: number; height: number }, points: Pt[]): { index: number; measured: string } {
  const W = image.width, H = image.height;
  const scale = Math.min(1, 800 / Math.max(W, H));
  const c = document.createElement('canvas');
  c.width = Math.round(W * scale); c.height = Math.round(H * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, c.width, c.height);
  const r = Math.max(2, Math.round(c.width * 0.006));
  const samples: RGB[] = [];
  for (const i of SKIN_SAMPLES) {
    const p = points[i]; if (!p) continue;
    const x = Math.round(p.x * c.width), y = Math.round(p.y * c.height);
    const d = ctx.getImageData(Math.max(0, x - r), Math.max(0, y - r), r * 2 + 1, r * 2 + 1).data;
    const ch: number[][] = [[], [], []];
    for (let k = 0; k < d.length; k += 4) { ch[0].push(d[k]); ch[1].push(d[k + 1]); ch[2].push(d[k + 2]); }
    const med = (a: number[]) => a.sort((m, n) => m - n)[Math.floor(a.length / 2)];
    samples.push([med(ch[0]), med(ch[1]), med(ch[2])]);
  }
  samples.sort((a, b) => lab(a)[0] - lab(b)[0]);
  const kept = samples.length > 4 ? samples.slice(1, -1) : samples;
  const avg: RGB = [0, 1, 2].map(k => kept.reduce((s, v) => s + v[k], 0) / kept.length) as RGB;
  const target = lab(avg);
  let best = 0, bestD = Infinity;
  SKIN_TONES.forEach((t, i) => {
    const L = lab(hexToRgb(t.hex));
    // Lightness counts double: depth is what separates the tones; hue differences inside one depth
    // are mostly the light in the photo.
    const d = 2 * (L[0] - target[0]) ** 2 + (L[1] - target[1]) ** 2 + (L[2] - target[2]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return { index: best, measured: rgbToHex(avg) };
}

/** The complexion shades that follow the chosen skin tone. */
export function toneShades(toneHex: string) {
  return {
    foundation: toneHex,
    concealer: mix(toneHex, '#FFF4EA', 0.22),
    contour: mix(toneHex, '#3A2418', 0.32),
    bronzer: mix(toneHex, '#9A5A2E', 0.38),
    highlighter: mix(toneHex, '#FFF1DC', 0.62),
    tan: mix(toneHex, '#9A5A2E', 0.5),
  };
}

// ---------------------------------------------------------------------------------------------
// The look

export type LipMode = 'none' | 'tint' | 'bold';
export type Coverage = 'sheer' | 'light' | 'medium';

export type Look = {
  tone: number;
  lips: { mode: LipMode; color: string; liner: boolean; gloss: boolean; plump: number; strength: number };
  eyes: { on: boolean; color: string; crease: boolean; wing: boolean; lashLine: boolean; oneEye: boolean; strength: number };
  lashes: { on: boolean; mascara: string; liner: boolean; falseLashes: boolean; brows: boolean; brow: string; strength: number };
  skin: { on: boolean; coverage: Coverage; underEye: boolean; blemishes: boolean; strength: number };
  sculpt: { on: boolean; contour: boolean; bronzer: boolean; highlighter: boolean; strength: number };
  glow: { on: boolean; blush: string; healthyGlow: boolean; tan: boolean; strength: number };
};

export function defaultLook(tone: number, naturalLip: string): Look {
  return {
    tone,
    lips: { mode: 'tint', color: naturalLip, liner: false, gloss: false, plump: 0, strength: 70 },
    eyes: { on: false, color: '#8A5A3C', crease: true, wing: false, lashLine: true, oneEye: false, strength: 70 },
    lashes: { on: false, mascara: '#1E1714', liner: true, falseLashes: false, brows: true, brow: '#3B2A22', strength: 70 },
    skin: { on: false, coverage: 'light', underEye: true, blemishes: true, strength: 70 },
    sculpt: { on: false, contour: true, bronzer: true, highlighter: true, strength: 60 },
    glow: { on: false, blush: '#E08A6E', healthyGlow: true, tan: false, strength: 60 },
  };
}

/** Lip shades on offer. Not tied to skin tone, so there are more than ten. */
export const LIP_SHADES = ['#C98A80', '#B8656A', '#B85F55', '#E07A5F', '#E9967A', '#A86B4F', '#9C6B7E', '#8E3B5A',
  '#9E3A32', '#A4161A', '#6B2D4A', '#6E3B2E', '#D4A5A5', '#4A1C2C'];
export const EYE_SHADES = ['#B79A86', '#8A5A3C', '#D8BFA4', '#C08A6A', '#7A5C8E', '#6B6A3E', '#2F3E5C', '#B76E5A',
  '#3A2A22', '#8C7B8F', '#5E5E66', '#A0522D'];
export const BLUSH_SHADES = ['#F4A6A0', '#E08A6E', '#E9967A', '#D46A6A', '#C2566B', '#B5655A', '#A44A3F', '#8E3B46',
  '#D98C7A', '#F2B5A0', '#C47A5A', '#7E2F3B'];
export const MASCARA_SHADES = ['#111111', '#1E1714', '#3B2A22', '#2F3E5C'];
export const BROW_SHADES = ['#C9A675', '#A47C52', '#8C6A47', '#6B4A33', '#3B2A22', '#22201F', '#7A7A7A', '#8B3A1E'];

/** Read the visitor's own lip colour, so the sheer tint starts close to it. */
export function detectLipColor(image: CanvasImageSource & { width: number; height: number }, points: Pt[]): string {
  const c = document.createElement('canvas');
  const scale = Math.min(1, 800 / Math.max(image.width, image.height));
  c.width = Math.round(image.width * scale); c.height = Math.round(image.height * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, c.width, c.height);
  const at = (i: number, j: number, t: number) => {
    const a = points[i], b = points[j];
    return { x: (a.x + (b.x - a.x) * t) * c.width, y: (a.y + (b.y - a.y) * t) * c.height };
  };
  // Middle of the lower lip and of the upper lip, between the outer and inner line.
  const spots = [at(17, 14, 0.5), at(0, 13, 0.5), at(84, 87, 0.5), at(314, 317, 0.5)];
  const acc: number[] = [0, 0, 0];
  for (const s of spots) {
    const d = ctx.getImageData(Math.round(s.x) - 1, Math.round(s.y) - 1, 3, 3).data;
    for (let k = 0; k < d.length; k += 4) { acc[0] += d[k]; acc[1] += d[k + 1]; acc[2] += d[k + 2]; }
  }
  const n = spots.length * 9;
  const natural = rgbToHex([acc[0] / n, acc[1] / n, acc[2] / n]);
  // The nearest shade on offer, so the starting choice is one the visitor can see selected.
  let best = LIP_SHADES[0], bestD = Infinity;
  const L0 = lab(hexToRgb(natural));
  for (const s of LIP_SHADES) {
    const L = lab(hexToRgb(s));
    const d = (L[0] - L0[0]) ** 2 + (L[1] - L0[1]) ** 2 + (L[2] - L0[2]) ** 2;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Painting

type Ctx = CanvasRenderingContext2D;

function canvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!];
}

/**
 * Soften a mask by shrinking it and stretching it back. Works in every browser, where the canvas
 * `filter` property does not (Safari only gained it recently). `radius` is in output pixels.
 */
function soften(mask: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  if (radius < 1) return mask;
  const f = Math.max(1, radius / 1.5);
  const [small, sctx] = canvas(Math.max(1, Math.round(mask.width / f)), Math.max(1, Math.round(mask.height / f)));
  sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(mask, 0, 0, small.width, small.height);
  const [out, octx] = canvas(mask.width, mask.height);
  octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = 'high';
  octx.drawImage(small, 0, 0, out.width, out.height);
  return out;
}

/** Lay `color` over the picture through `mask`, with a blend mode and an opacity. */
function paint(ctx: Ctx, mask: HTMLCanvasElement, color: string, mode: GlobalCompositeOperation, alpha: number) {
  if (alpha <= 0) return;
  const [layer, lctx] = canvas(mask.width, mask.height);
  lctx.fillStyle = color;
  lctx.fillRect(0, 0, layer.width, layer.height);
  lctx.globalCompositeOperation = 'destination-in';
  lctx.drawImage(mask, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = mode;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

/** Lay a picture (rather than a flat colour) over the canvas through a mask. */
function paintImage(ctx: Ctx, image: CanvasImageSource, mask: HTMLCanvasElement, alpha: number, mode: GlobalCompositeOperation = 'source-over') {
  if (alpha <= 0) return;
  const [layer, lctx] = canvas(mask.width, mask.height);
  lctx.drawImage(image, 0, 0, layer.width, layer.height);
  lctx.globalCompositeOperation = 'destination-in';
  lctx.drawImage(mask, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = mode;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

/** The photo blurred, for evening out skin under foundation. */
function blurred(image: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  return soften(image, radius);
}

function mask(w: number, h: number, draw: (ctx: Ctx) => void, blur = 0): HTMLCanvasElement {
  const [m, mctx] = canvas(w, h);
  mctx.fillStyle = '#fff'; mctx.strokeStyle = '#fff';
  mctx.lineCap = 'round'; mctx.lineJoin = 'round';
  draw(mctx);
  return soften(m, blur);
}

const polygon = (ctx: Ctx, pts: Pt[]) => {
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
};
const polyline = (ctx: Ctx, pts: Pt[]) => {
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
};
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
const len = (a: Pt) => Math.hypot(a.x, a.y);
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const centre = (pts: Pt[]): Pt => mul(pts.reduce((s, p) => add(s, p), { x: 0, y: 0 }), 1 / pts.length);
const scaleAbout = (pts: Pt[], c: Pt, sx: number, sy: number) => pts.map(p => ({ x: c.x + (p.x - c.x) * sx, y: c.y + (p.y - c.y) * sy }));

/**
 * Paint a look onto a canvas that already holds the photo at its working size.
 *
 * @param out     canvas holding the original photo, drawn at width × height
 * @param points  normalised landmarks from {@link detectFace}
 */
export function renderLook(out: HTMLCanvasElement, points: Pt[], look: Look) {
  const W = out.width, H = out.height;
  const ctx = out.getContext('2d')!;
  const P = (i: number): Pt => ({ x: points[i].x * W, y: points[i].y * H });
  const ring = (ids: number[]) => ids.map(P);

  const oval = ring(FACE_OVAL);
  const faceW = len(sub(P(454), P(234)));
  const original = document.createElement('canvas');
  original.width = W; original.height = H;
  original.getContext('2d')!.drawImage(out, 0, 0);

  const tone = SKIN_TONES[look.tone] ?? SKIN_TONES[3];
  const shades = toneShades(tone.hex);

  const eye = (side: 'right' | 'left') => {
    const d = EYES[side];
    const upper = ring(d.upper), lower = ring(d.lower);
    const outer = P(d.outer), inner = P(d.inner);
    const width = len(sub(outer, inner));
    const browC = centre([...ring(d.browLower), ...ring(d.browUpper)]);
    const eyeC = centre([...upper, ...lower]);
    const up = sub(browC, eyeC);
    return { upper, lower, outer, inner, width, up, eyeC, brow: { upper: ring(d.browUpper), lower: ring(d.browLower) } };
  };
  const eyes = { right: eye('right'), left: eye('left') };
  // In a turned head the far eye is mostly hidden, and the landmarker still places it, squeezed
  // against the nose. Painting it puts lashes and liner on the bridge of the nose, so an eye much
  // narrower than the other is treated as not visible and left alone.
  const widest = Math.max(eyes.right.width, eyes.left.width);
  const visible = (side: 'right' | 'left') => eyes[side].width >= widest * 0.55;

  // Skin: the face oval without the eyes, brows and mouth.
  const skinMask = () => mask(W, H, m => {
    m.beginPath(); polygon(m, oval); m.fill();
    m.globalCompositeOperation = 'destination-out';
    for (const e of [eyes.right, eyes.left]) {
      m.beginPath(); polygon(m, [...e.upper, ...e.lower.slice(1)].map(p => add(e.eyeC, mul(sub(p, e.eyeC), 1.35)))); m.fill();
      m.beginPath(); polygon(m, [...e.brow.upper, ...[...e.brow.lower].reverse()]); m.fill();
    }
    m.beginPath(); polygon(m, scaleAbout(ring(LIPS_OUTER), centre(ring(LIPS_OUTER)), 1.12, 1.25)); m.fill();
  }, faceW * 0.035);

  // 1. Foundation, concealer, BB: even the skin out, then warm it toward the matched shade.
  if (look.skin.on) {
    const s = look.skin.strength / 100;
    const cover = { sheer: 0.22, light: 0.38, medium: 0.55 }[look.skin.coverage] + (look.skin.blemishes ? 0.1 : 0);
    const sm = skinMask();
    paintImage(ctx, blurred(original, faceW * 0.018), sm, cover * s);
    paint(ctx, sm, shades.foundation, 'color', 0.18 * s);
    paint(ctx, sm, shades.foundation, 'soft-light', 0.12 * s);
    if (look.skin.underEye) {
      for (const e of [eyes.right, eyes.left]) {
        const down = mul(e.up, -1);
        const band = mask(W, H, m => {
          m.beginPath();
          polygon(m, [...e.lower.slice(1, -1).map(p => add(p, mul(down, 0.08))), ...[...e.lower.slice(1, -1)].reverse().map(p => add(p, mul(down, 0.62)))]);
          m.fill();
        }, e.width * 0.18);
        paintImage(ctx, blurred(original, faceW * 0.02), band, 0.5 * s);
        paint(ctx, band, shades.concealer, 'screen', 0.22 * s);
      }
    }
  }

  // 2. Tan and healthy glow, across the whole face.
  if (look.glow.on && (look.glow.tan || look.glow.healthyGlow)) {
    const s = look.glow.strength / 100;
    const sm = skinMask();
    if (look.glow.tan) paint(ctx, sm, shades.tan, 'multiply', 0.16 * s);
    if (look.glow.healthyGlow) paint(ctx, sm, '#FFD3B0', 'soft-light', 0.28 * s);
  }

  // 3. Contour, bronzer, highlighter.
  if (look.sculpt.on) {
    const s = look.sculpt.strength / 100;
    if (look.sculpt.contour) {
      const m = mask(W, H, c => {
        c.lineWidth = faceW * 0.06;
        for (const [ear, mouth] of [[234, 61], [454, 291]]) {
          // Under the cheekbone: from in front of the ear toward the corner of the mouth, stopping halfway.
          const a = lerp(P(ear), P(mouth), 0.08), b = lerp(P(ear), P(mouth), 0.48);
          const dropBy = faceW * 0.03;
          c.beginPath(); c.moveTo(a.x, a.y + dropBy * 0.2); c.lineTo(b.x, b.y + dropBy); c.stroke();
        }
        // Sides of the nose.
        c.lineWidth = faceW * 0.02;
        for (const side of [98, 327]) {
          const top = lerp(P(6), P(side), 0.25), bottom = lerp(P(side), P(6), 0.15);
          const off = mul(sub(P(side), P(4)), 0.55);
          c.beginPath(); c.moveTo(top.x + off.x * 0.3, top.y); c.lineTo(bottom.x, bottom.y); c.stroke();
        }
        // Under the jaw.
        c.lineWidth = faceW * 0.05;
        c.beginPath(); polyline(c, ring([172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397])); c.stroke();
      }, faceW * 0.075);
      paint(ctx, m, shades.contour, 'multiply', 0.26 * s);
    }
    if (look.sculpt.bronzer) {
      const m = mask(W, H, c => {
        for (const i of [54, 284, 103, 332]) { const p = P(i); c.beginPath(); c.ellipse(p.x, p.y, faceW * 0.1, faceW * 0.08, 0, 0, Math.PI * 2); c.fill(); }
        for (const i of [123, 352]) { const p = P(i); c.beginPath(); c.ellipse(p.x, p.y, faceW * 0.09, faceW * 0.07, 0, 0, Math.PI * 2); c.fill(); }
      }, faceW * 0.09);
      paint(ctx, m, shades.bronzer, 'soft-light', 0.35 * s);
      paint(ctx, m, shades.bronzer, 'multiply', 0.12 * s);
    }
    if (look.sculpt.highlighter) {
      const m = mask(W, H, c => {
        // On the top of the cheekbone, nearer the nose than the ear, where light actually lands.
        for (const [i, toward] of [[117, 6], [346, 6]]) { const p = lerp(P(i), P(toward), 0.15); c.beginPath(); c.ellipse(p.x, p.y, faceW * 0.045, faceW * 0.018, 0, 0, Math.PI * 2); c.fill(); }
        c.lineWidth = faceW * 0.022; c.beginPath(); polyline(c, ring([168, 6, 197, 195])); c.stroke();
        const bow = P(0); c.beginPath(); c.ellipse(bow.x, bow.y - faceW * 0.012, faceW * 0.018, faceW * 0.008, 0, 0, Math.PI * 2); c.fill();
      }, faceW * 0.05);
      paint(ctx, m, shades.highlighter, 'soft-light', 0.5 * s);
      paint(ctx, m, shades.highlighter, 'screen', 0.14 * s);
    }
  }

  // 4. Blush on the apples of the cheeks, angled slightly up toward the temples.
  if (look.glow.on) {
    const s = look.glow.strength / 100;
    const m = mask(W, H, c => {
      for (const [apple, toward] of [[205, 117], [425, 346]]) {
        const p = lerp(P(apple), P(toward), 0.35);
        const dir = sub(P(toward), P(apple));
        c.beginPath(); c.ellipse(p.x, p.y, faceW * 0.1, faceW * 0.065, Math.atan2(dir.y, dir.x), 0, Math.PI * 2); c.fill();
      }
    }, faceW * 0.07);
    paint(ctx, m, look.glow.blush, 'multiply', 0.32 * s);
    paint(ctx, m, look.glow.blush, 'soft-light', 0.3 * s);
  }

  // 5. Eyes: lid, crease, wing, lash line. One eye only leaves the person's left eye bare.
  if (look.eyes.on) {
    const s = look.eyes.strength / 100;
    for (const side of ['right', 'left'] as const) {
      if (look.eyes.oneEye && side === 'left') continue;
      if (!visible(side)) continue;
      const e = eyes[side];
      // How far above the lash line each point of the lid goes: most in the middle, least at the corners.
      const lid = (t: number) => e.upper.map((p, i) => add(p, mul(e.up, t * (0.25 + 0.75 * Math.sin((Math.PI * i) / (e.upper.length - 1))))));
      const lidMask = mask(W, H, c => { c.beginPath(); polygon(c, [...e.upper, ...lid(0.3).reverse()]); c.fill(); }, e.width * 0.05);
      paint(ctx, lidMask, look.eyes.color, 'multiply', 0.55 * s);
      if (look.eyes.crease) {
        const crease = mask(W, H, c => { c.beginPath(); polygon(c, [...lid(0.24), ...lid(0.42).reverse()]); c.fill(); }, e.width * 0.07);
        paint(ctx, crease, mix(look.eyes.color, '#2A1A12', 0.35), 'multiply', 0.5 * s);
      }
      if (look.eyes.wing) {
        const dir = mul(sub(e.outer, e.inner), 1 / e.width);
        const tip = add(add(e.outer, mul(dir, e.width * 0.28)), mul(e.up, 0.14));
        const wing = mask(W, H, c => { c.beginPath(); polygon(c, [e.upper[1], tip, add(e.outer, mul(e.up, -0.02))]); c.fill(); }, e.width * 0.012);
        paint(ctx, wing, '#2B1E18', 'multiply', 0.85 * s);
      }
      if (look.eyes.lashLine) {
        const line = mask(W, H, c => { c.lineWidth = e.width * 0.05; c.beginPath(); polyline(c, e.upper); c.stroke(); }, e.width * 0.02);
        paint(ctx, line, '#2B1E18', 'multiply', 0.6 * s);
      }
    }
  }

  // 6. Mascara, liner, lashes, brows.
  if (look.lashes.on) {
    const s = look.lashes.strength / 100;
    for (const side of ['right', 'left'] as const) {
      if (!visible(side)) continue;
      const e = eyes[side];
      if (look.lashes.liner) {
        const line = mask(W, H, c => { c.lineWidth = e.width * 0.04; c.beginPath(); polyline(c, e.upper); c.stroke(); }, e.width * 0.012);
        paint(ctx, line, '#2B1E18', 'multiply', 0.8 * s);
      }
      // Lashes: short strokes out from the upper lid, longer toward the outer corner.
      const lashes = mask(W, H, c => {
        c.lineWidth = Math.max(1, e.width * 0.012);
        const len0 = e.width * (look.lashes.falseLashes ? 0.2 : 0.11);
        const outerIsLast = len(sub(e.upper[e.upper.length - 1], e.outer)) < len(sub(e.upper[0], e.outer));
        for (let i = 0; i < e.upper.length - 1; i++) {
          for (let k = 0; k < 3; k++) {
            const t = (i + k / 3) / (e.upper.length - 1);
            const p = lerp(e.upper[i], e.upper[i + 1], k / 3);
            const towardOuter = outerIsLast ? t : 1 - t;
            const outward = sub(p, e.eyeC);
            const dir = mul(add(mul(outward, 1 / Math.max(1, len(outward))), mul(e.up, 1 / Math.max(1, len(e.up)))), 0.5);
            const L = len0 * (0.6 + 0.6 * towardOuter);
            const end = add(p, mul(dir, L));
            c.beginPath(); c.moveTo(p.x, p.y); c.quadraticCurveTo(p.x + dir.x * L * 0.5, p.y + dir.y * L * 0.2, end.x, end.y); c.stroke();
          }
        }
        // A thicker base along the lash line, which is most of what mascara looks like at this size.
        c.lineWidth = e.width * 0.035; c.beginPath(); polyline(c, e.upper); c.stroke();
      }, 0.6);
      paint(ctx, lashes, look.lashes.mascara, 'multiply', 0.85 * s);
      if (look.lashes.brows) {
        const brow = mask(W, H, c => { c.beginPath(); polygon(c, [...e.brow.upper, ...[...e.brow.lower].reverse()]); c.fill(); }, e.width * 0.035);
        paint(ctx, brow, look.lashes.brow, 'multiply', 0.45 * s);
        paint(ctx, brow, look.lashes.brow, 'color', 0.3 * s);
      }
    }
  }

  // 7. Lips last, so nothing paints over them. Fuller lips first, then the colour on the new shape.
  if (look.lips.mode !== 'none') {
    const s = look.lips.strength / 100;
    let outerPts = ring(LIPS_OUTER), innerPts = ring(LIPS_INNER);
    const lc = centre(outerPts);
    const plump = Math.max(0, Math.min(7, look.lips.mode === 'bold' ? look.lips.plump : 0)) / 100;
    if (plump > 0) {
      const box = outerPts.reduce((b, p) => ({ x0: Math.min(b.x0, p.x), y0: Math.min(b.y0, p.y), x1: Math.max(b.x1, p.x), y1: Math.max(b.y1, p.y) }),
        { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
      const pad = (box.x1 - box.x0) * 0.25;
      const sx = box.x0 - pad, sy = box.y0 - pad, sw = box.x1 - box.x0 + pad * 2, sh = box.y1 - box.y0 + pad * 2;
      const kx = 1 + plump * 0.5, ky = 1 + plump;
      const [tmp, tctx] = canvas(W, H);
      tctx.drawImage(original, sx, sy, sw, sh, lc.x - (lc.x - sx) * kx, lc.y - (lc.y - sy) * ky, sw * kx, sh * ky);
      const area = mask(W, H, c => { c.beginPath(); polygon(c, scaleAbout(outerPts, lc, 1.35, 1.6)); c.fill(); }, (box.x1 - box.x0) * 0.08);
      paintImage(ctx, tmp, area, 1);
      outerPts = scaleAbout(outerPts, lc, kx, ky);
      innerPts = scaleAbout(innerPts, lc, kx, ky);
    }
    const lipW = len(sub(P(291), P(61)));
    const lips = mask(W, H, c => {
      c.beginPath(); polygon(c, outerPts); polygon(c, innerPts); c.fill('evenodd');
    }, lipW * 0.02);
    if (look.lips.mode === 'tint') {
      paint(ctx, lips, look.lips.color, 'color', 0.5 * s);
      paint(ctx, lips, look.lips.color, 'multiply', 0.18 * s);
    } else {
      paint(ctx, lips, look.lips.color, 'multiply', 0.4 * s);
      paint(ctx, lips, look.lips.color, 'color', 0.9 * s);
      if (look.lips.liner) {
        const line = mask(W, H, c => { c.lineWidth = lipW * 0.022; c.beginPath(); polygon(c, outerPts); c.stroke(); }, lipW * 0.012);
        paint(ctx, line, mix(look.lips.color, '#1A0A08', 0.3), 'multiply', 0.45 * s);
      }
      if (look.lips.gloss) {
        const shine = mask(W, H, c => {
          const lowerMid = lerp(lerp(P(17), P(14), 0.45), lc, 0), upperMid = lerp(P(0), P(13), 0.55);
          c.beginPath(); c.ellipse(lowerMid.x, lowerMid.y, lipW * 0.14, lipW * 0.035, 0, 0, Math.PI * 2); c.fill();
          c.beginPath(); c.ellipse(upperMid.x, upperMid.y, lipW * 0.07, lipW * 0.018, 0, 0, Math.PI * 2); c.fill();
        }, lipW * 0.03);
        const inside = document.createElement('canvas'); inside.width = W; inside.height = H;
        const ictx = inside.getContext('2d')!;
        ictx.drawImage(shine, 0, 0); ictx.globalCompositeOperation = 'destination-in'; ictx.drawImage(lips, 0, 0);
        paint(ctx, inside, '#FFFFFF', 'screen', 0.45 * s);
      }
    }
  }
}

/**
 * Draw `other` (another picture of the same face, e.g. the AI version) onto a canvas framed like
 * the original, by matching the centres of the two eyes. The AI may return a different crop or
 * size; without this the two halves of a before/after slider do not line up.
 */
export async function alignTo(original: Pt[], width: number, height: number,
                              other: CanvasImageSource & { width: number; height: number },
                              under?: CanvasImageSource): Promise<HTMLCanvasElement | null> {
  const found = await detectFace(other);
  if (!found.ok) return null;
  const eyeMid = (pts: Pt[], w: number, h: number, ids: number[]) => {
    const c = ids.map(i => ({ x: pts[i].x * w, y: pts[i].y * h }));
    return { x: c.reduce((s, p) => s + p.x, 0) / c.length, y: c.reduce((s, p) => s + p.y, 0) / c.length };
  };
  const R = [33, 133], L = [263, 362];
  const a1 = eyeMid(original, width, height, R), a2 = eyeMid(original, width, height, L);
  const b1 = eyeMid(found.points, other.width, other.height, R), b2 = eyeMid(found.points, other.width, other.height, L);
  const da = Math.hypot(a2.x - a1.x, a2.y - a1.y), db = Math.hypot(b2.x - b1.x, b2.y - b1.y);
  if (!db) return null;
  const k = da / db;
  const ca = { x: (a1.x + a2.x) / 2, y: (a1.y + a2.y) / 2 }, cb = { x: (b1.x + b2.x) / 2, y: (b1.y + b2.y) / 2 };
  const out = document.createElement('canvas');
  out.width = width; out.height = height;
  const ctx = out.getContext('2d')!;
  // Where the other picture does not reach the edge, the original shows instead of a dark band.
  if (under) ctx.drawImage(under, 0, 0, width, height);
  else { ctx.fillStyle = '#0E1223'; ctx.fillRect(0, 0, width, height); }
  ctx.translate(ca.x - cb.x * k, ca.y - cb.y * k);
  ctx.scale(k, k);
  ctx.drawImage(other, 0, 0);
  return out;
}
