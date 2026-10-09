// Hand-tuned pigment pairs. Each hand gets one pigment.
//
// `absorb` is how strongly a pigment removes red, green and blue light per
// unit of concentration; a low value in one channel is what gives a thin
// wash its hue. `body` is the colour a thick layer settles on.

export type RGB = [number, number, number];

export interface Pigment {
  name: string;
  /** Colour of a thick layer as a hex code, for swatches and labels. */
  tint: string;
  absorb: RGB;
  body: RGB; // linear light
  /** How opaque a thick layer is: 0 = pure dye, 1 = paint. */
  cover: number;
}

export interface Palette {
  name: string;
  first: Pigment;
  second: Pigment;
  /** Tint of the paper for this pairing (linear multiplier). */
  paper: RGB;
  /** Metallic glint on the second pigment. */
  sheen: number;
}

function hex(code: string): RGB {
  const n = parseInt(code.slice(1), 16);
  const channel = (v: number) => Math.pow(v / 255, 2.2);
  return [channel((n >> 16) & 255), channel((n >> 8) & 255), channel(n & 255)];
}

export const PALETTES: Palette[] = [
  {
    name: 'Sumi',
    first: { name: 'Sumi', tint: '#0a0b0e', absorb: [3.5, 3.35, 2.95], body: hex('#0a0b0e'), cover: 0.55 },
    second: { name: 'Indigo', tint: '#0f1a36', absorb: [3.1, 2.4, 1.2], body: hex('#0f1a36'), cover: 0.5 },
    paper: [1.0, 1.0, 1.0],
    sheen: 0,
  },
  {
    name: 'Indigo & Vermilion',
    first: { name: 'Indigo', tint: '#101d4d', absorb: [3.4, 2.6, 1.0], body: hex('#101d4d'), cover: 0.5 },
    second: { name: 'Vermilion', tint: '#b3261a', absorb: [0.4, 2.7, 3.0], body: hex('#b3261a'), cover: 0.6 },
    paper: [1.0, 0.99, 0.97],
    sheen: 0,
  },
  {
    name: 'Oxblood & Gold',
    first: { name: 'Oxblood', tint: '#47090f', absorb: [1.05, 3.2, 2.9], body: hex('#47090f'), cover: 0.55 },
    second: { name: 'Gold', tint: '#c2912f', absorb: [0.28, 0.85, 2.3], body: hex('#c2912f'), cover: 0.8 },
    paper: [1.0, 0.975, 0.93],
    sheen: 1,
  },
  {
    name: 'Celadon & Plum',
    first: { name: 'Celadon', tint: '#2c5a50', absorb: [2.1, 1.0, 1.4], body: hex('#2c5a50'), cover: 0.5 },
    second: { name: 'Plum', tint: '#40193c', absorb: [1.55, 2.8, 1.55], body: hex('#40193c'), cover: 0.5 },
    paper: [1.0, 0.985, 0.955],
    sheen: 0,
  },
];

export function mixPalette(a: Palette, b: Palette, t: number): Palette {
  const lerp = (x: RGB, y: RGB): RGB => [
    x[0] + (y[0] - x[0]) * t,
    x[1] + (y[1] - x[1]) * t,
    x[2] + (y[2] - x[2]) * t,
  ];
  const pigment = (x: Pigment, y: Pigment): Pigment => ({
    name: t < 0.5 ? x.name : y.name,
    tint: t < 0.5 ? x.tint : y.tint,
    absorb: lerp(x.absorb, y.absorb),
    body: lerp(x.body, y.body),
    cover: x.cover + (y.cover - x.cover) * t,
  });
  return {
    name: t < 0.5 ? a.name : b.name,
    first: pigment(a.first, b.first),
    second: pigment(a.second, b.second),
    paper: lerp(a.paper, b.paper),
    sheen: a.sheen + (b.sheen - a.sheen) * t,
  };
}
