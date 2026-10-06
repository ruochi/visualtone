import { glyph } from './font.js';

export type RGB = [number, number, number];

export class Canvas {
  readonly px: Uint8Array;

  constructor(
    readonly w: number,
    readonly h: number,
    bg: RGB = [14, 16, 22],
  ) {
    this.px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      this.px[i * 4] = bg[0];
      this.px[i * 4 + 1] = bg[1];
      this.px[i * 4 + 2] = bg[2];
      this.px[i * 4 + 3] = 255;
    }
  }

  set(x: number, y: number, c: RGB, a = 255) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return;
    const i = (yi * this.w + xi) * 4;
    if (a >= 255) {
      this.px[i] = c[0];
      this.px[i + 1] = c[1];
      this.px[i + 2] = c[2];
      this.px[i + 3] = 255;
      return;
    }
    const t = a / 255;
    this.px[i] = this.px[i] * (1 - t) + c[0] * t;
    this.px[i + 1] = this.px[i + 1] * (1 - t) + c[1] * t;
    this.px[i + 2] = this.px[i + 2] * (1 - t) + c[2] * t;
  }

  fillRect(x: number, y: number, w: number, h: number, c: RGB) {
    if (!(w > 0) || !(h > 0)) return;
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.ceil(x + w));
    const y1 = Math.min(this.h, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) this.set(xx, yy, c);
    }
  }

  strokeRect(x: number, y: number, w: number, h: number, c: RGB) {
    this.hline(x, x + w, y, c);
    this.hline(x, x + w, y + h - 1, c);
    this.vline(x, y, y + h, c);
    this.vline(x + w - 1, y, y + h, c);
  }

  hline(x0: number, x1: number, y: number, c: RGB) {
    const y0 = Math.round(y);
    let a = Math.round(x0);
    let b = Math.round(x1);
    if (b < a) [a, b] = [b, a];
    for (let x = a; x <= b; x++) this.set(x, y0, c);
  }

  vline(x: number, y0: number, y1: number, c: RGB) {
    const x0 = Math.round(x);
    let a = Math.round(y0);
    let b = Math.round(y1);
    if (b < a) [a, b] = [b, a];
    for (let y = a; y <= b; y++) this.set(x0, y, c);
  }

  line(x0: number, y0: number, x1: number, y1: number, c: RGB) {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.set(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), c);
    }
  }

  /** Returns the width in pixels. Unknown characters are skipped. */
  text(x: number, y: number, s: string, c: RGB, scale = 1): number {
    let cx = x;
    const up = s.toUpperCase().replace(/[–—]/g, '-').replace(/…/g, '...');
    for (const ch of up) {
      const rows = glyph(ch);
      if (!rows) continue;
      for (let row = 0; row < 7; row++) {
        const bits = rows[row];
        for (let col = 0; col < 5; col++) {
          if (bits & (1 << (4 - col))) {
            this.fillRect(cx + col * scale, y + row * scale, scale, scale, c);
          }
        }
      }
      cx += 6 * scale;
    }
    return cx - x;
  }
}

export function lerpColor(t: number): RGB {
  const stops: RGB[] = [
    [10, 12, 28],
    [28, 48, 140],
    [20, 150, 170],
    [210, 200, 50],
    [255, 244, 210],
  ];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  return [
    Math.round(stops[i][0] + (stops[i + 1][0] - stops[i][0]) * f),
    Math.round(stops[i][1] + (stops[i + 1][1] - stops[i][1]) * f),
    Math.round(stops[i][2] + (stops[i + 1][2] - stops[i][2]) * f),
  ];
}

export function hueRgb(hue: number, lightness = 0.6): RGB {
  const h = ((hue % 360) + 360) % 360;
  const s = 0.72;
  const l = 0.32 + lightness * 0.36;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
