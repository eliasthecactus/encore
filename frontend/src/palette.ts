/** Pull a few vivid colours out of the cover art for the animated backgrounds. */

export type RGB = [number, number, number];

export const DEFAULT_PALETTE: RGB[] = [
  [255, 79, 216],
  [124, 92, 255],
  [0, 200, 255],
  [255, 140, 66],
];

const cache = new Map<string, RGB[]>();

function hsl([r, g, b]: RGB): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
  }
  return [(h * 60 + 360) % 360, s, l];
}

/** Brighten dull colours so they glow on a dark stage. */
function vivid(c: RGB): RGB {
  const [h, s, l] = hsl(c);
  const S = Math.max(s, 0.55);
  const L = Math.min(Math.max(l, 0.45), 0.65);
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export async function paletteFrom(url: string): Promise<RGB[]> {
  if (!url) return DEFAULT_PALETTE;
  const hit = cache.get(url);
  if (hit) return hit;
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, 32, 32);
    const data = g.getImageData(0, 0, 32, 32).data;
    // Bucket by hue, weight by saturation so grey backgrounds don't win.
    const buckets = new Map<number, { w: number; c: [number, number, number] }>();
    for (let i = 0; i < data.length; i += 4) {
      const rgb: RGB = [data[i], data[i + 1], data[i + 2]];
      const [h, s, l] = hsl(rgb);
      if (l < 0.08 || l > 0.95) continue;
      const key = Math.round(h / 24);
      const w = 0.15 + s;
      const b = buckets.get(key) ?? { w: 0, c: [0, 0, 0] };
      b.w += w;
      b.c[0] += rgb[0] * w;
      b.c[1] += rgb[1] * w;
      b.c[2] += rgb[2] * w;
      buckets.set(key, b);
    }
    const top = [...buckets.values()].sort((a, b) => b.w - a.w).slice(0, 4);
    if (!top.length) return DEFAULT_PALETTE;
    const out = top.map((b) => vivid([b.c[0] / b.w, b.c[1] / b.w, b.c[2] / b.w]));
    while (out.length < 4) out.push(DEFAULT_PALETTE[out.length]);
    cache.set(url, out);
    return out;
  } catch {
    return DEFAULT_PALETTE;
  }
}

export const rgb = (c: RGB, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
