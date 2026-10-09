// The tracking overlay: what the hand tracker sees and what is measured from
// it, drawn like a computer-vision debug view. Every number shown is a value
// the ink is actually driven by.
//
// It is painted on an off-screen 2D canvas the size of the stage and handed
// to the final shader pass as a texture, so it is part of the picture and of
// any recording made from it.
//
// Two looks share one layout. The colour look uses three signal colours: one
// per hand, and green for measurements. The quiet look is monochrome; for it
// the canvas holds masks (red = mark, green and blue = the two pigments,
// black = edge) and the shader picks dark or light marks to suit the picture.

import { Motion } from './brush';
import { FINGERS, Gesture, HandState } from './hands';
import { Palette } from './palettes';

export const OVERLAY_MODES = ['full', 'mono', 'skeleton', 'off'] as const;
export type OverlayMode = (typeof OVERLAY_MODES)[number];

export interface OverlayFrame {
  /** Text for the tracking line of the status block, e.g. "6.2 MS". */
  track: string;
  fps: number;
  /** "CAMERA" or "PAPER". */
  background: string;
  palette: Palette;
  /** Motion of one fingertip of a tracked hand, if it is touching the water. */
  tip: (slot: number, finger: number) => Motion | null;
  /** Output of a whole hand, 0..1. */
  handLevel: (slot: number) => number;
  /** A hand's held pinch and how charged it is, if it is pinching. */
  held: (slot: number) => { x: number; y: number; charge: number } | null;
  /** Mouse or touch points acting as fingertips. */
  pointers: Motion[];
  /** Distance between the two hands (stage heights) and the stroke width it sets. */
  span: { distance: number; width: number } | null;
  /**
   * The last clap: where, how long ago in seconds, whether it was the first
   * or the second of a pair, and how much of the wait for a second is left.
   */
  clap: { x: number; y: number; age: number; count: 1 | 2; windowLeft: number; peak?: number } | null;
  /** The last finger snap: where, how long ago, and how loud (dB over the room). */
  snap: { x: number; y: number; age: number; peak: number } | null;
  /** The last sharp sound that no hand accounted for. */
  unplaced: { age: number; peak: number } | null;
  /**
   * The microphone: its level and the level a sound must exceed, in dB
   * relative to full scale, or a word to show when there is no meter.
   */
  mic: { label: string; level: number | null; threshold: number | null };
  /** True while a clap is under way: the hands' own measurements step back. */
  clapping: boolean;
  /** The last double pinch: where and how long ago. */
  twin: { x: number; y: number; age: number } | null;
}

interface Inks {
  hand: [string, string];
  measure: string;
  text: string;
  pigment: [string, string];
  /** Text drawn on top of a filled tag. */
  onTag: string;
  /** The thin edge that keeps type legible. */
  textEdge: string;
}

const MASK_INKS: Inks = {
  hand: ['#ff0000', '#ff0000'],
  measure: '#ff0000',
  text: '#ff0000',
  pigment: ['#00ff00', '#0000ff'],
  onTag: '#000000',
  textEdge: '#000000',
};
const SIGNAL = { red: '#ff4d5e', blue: '#4b9dff', green: '#3ee68c', white: '#ffffff' };
const EDGE = '#000000';
const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

// Pairs of landmark indices joined by a bone.
const BONES: [number, number][] = [
  ...FINGERS.flatMap((f) => [
    [f[0], f[1]],
    [f[1], f[2]],
    [f[2], f[3]],
  ]),
  [0, 1],
  [0, 5],
  [5, 9],
  [9, 13],
  [13, 17],
  [0, 17],
] as [number, number][];
const TIPS = FINGERS.map((f) => f[3] as number);

const STATE_NAMES: Record<Gesture, string> = { point: 'DRAW', open: 'STIR', pinch: 'DROP', snap: 'ARMED', rest: 'IDLE' };

interface XY {
  x: number;
  y: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Track {
  /** Smoothed landmark positions in stage pixels. */
  pts: XY[];
  goal: XY[];
  state: HandState | null;
  presence: number;
  visible: boolean;
  /** Where the readout block sits, smoothed separately so it glides. */
  label: XY | null;
  /** Seconds since this hand last let a drop go; large when it has not. */
  sinceDrop: number;
  dropAt: XY;
}

function newTrack(): Track {
  return { pts: [], goal: [], state: null, presence: 0, visible: false, label: null, sinceDrop: 99, dropAt: { x: 0, y: 0 } };
}

export class Overlay {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tracks: Track[] = [newTrack(), newTrack()];
  private handCount = 0;
  private w = 1920;
  private h = 1080;
  /** One consistent stroke weight for every line. */
  private weight = 2.4;
  private type = 1;
  private inks: Inks = MASK_INKS;
  /** Rectangles already holding text this frame, so labels can avoid them. */
  private taken: Box[] = [];

  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.resize(this.w, this.h);
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const track of this.tracks) {
      track.pts = [];
      track.label = null;
    }
  }

  /** Takes the latest tracking result. Pass null when there is nothing new. */
  update(hands: HandState[] | null): void {
    if (!hands) return;
    this.handCount = hands.length;
    for (const track of this.tracks) track.visible = false;
    for (const hand of hands) {
      const track = this.tracks[hand.slot];
      track.visible = true;
      track.state = hand;
      track.goal = hand.points.map((p) => ({ x: p.x * this.w, y: p.y * this.h }));
      // A hand that has just appeared starts where it is, not where it was.
      if (track.presence < 0.02 || track.pts.length === 0) track.pts = track.goal.map((p) => ({ ...p }));
      if (hand.pinched) {
        track.sinceDrop = 0;
        track.dropAt = { x: hand.pinchPoint.x * this.w, y: hand.pinchPoint.y * this.h };
      }
    }
  }

  /**
   * Paints the overlay. `pixelScale` is how many screen pixels one stage
   * pixel covers. Returns false when nothing was drawn.
   */
  draw(mode: OverlayMode, pixelScale: number, dt: number, frame: OverlayFrame): boolean {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (mode === 'off') return false;

    this.inks =
      mode === 'mono'
        ? MASK_INKS
        : {
            hand: [SIGNAL.red, SIGNAL.blue],
            measure: SIGNAL.green,
            // White type over the camera, near-black type on paper.
            text: frame.background === 'PAPER' ? '#121214' : SIGNAL.white,
            pigment: [frame.palette.first.tint, frame.palette.second.tint],
            onTag: '#0b0b0c',
            textEdge: frame.background === 'PAPER' ? '#ffffff' : '#000000',
          };
    this.taken = [];

    // Keep lines and type legible when the stage is shown small.
    const shrink = 1 / Math.max(pixelScale, 0.2);
    this.weight = Math.min(3.6, Math.max(2.4, 1.5 * shrink));
    this.type = Math.min(1.45, Math.max(1, 0.8 * shrink));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const follow = 1 - Math.exp(-dt / 0.035);
    const fade = 1 - Math.exp(-dt / 0.09);
    for (const track of this.tracks) {
      track.presence += ((track.visible ? 1 : 0) - track.presence) * fade;
      track.sinceDrop += dt;
      for (let i = 0; i < track.pts.length; i++) {
        track.pts[i].x += (track.goal[i].x - track.pts[i].x) * follow;
        track.pts[i].y += (track.goal[i].y - track.pts[i].y) * follow;
      }
    }

    const full = mode !== 'skeleton';
    this.frameMarks(full);
    if (full) this.statusBlock(frame);

    const shown = this.tracks
      .map((track, slot) => ({ track, slot }))
      .filter(({ track }) => track.presence >= 0.02 && track.state !== null && track.pts.length > 0);
    // Shapes first, then the blocks of text, then the loose labels, which
    // step aside for anything already placed.
    for (const { track, slot } of shown) this.skeleton(track, slot, full, frame);
    if (full) {
      // When the hands are on top of each other (a clap), their labels would
      // pile up, so only the skeletons and the event itself are shown.
      const together = frame.span !== null && frame.span.distance < 0.34;
      if (!together) for (const { track, slot } of shown) this.readout(track, slot, dt, frame);
      if (!together && !frame.clapping) {
        for (const { track, slot } of shown) this.measures(track, slot, frame);
        this.spanLine(frame);
      }
    }
    for (const pointer of frame.pointers) this.pointer(pointer, full);
    if (full) this.moments(frame);
    return true;
  }

  // --- Drawing helpers -----------------------------------------------------------

  /** Strokes the current path: a dark edge, then the line itself. */
  private stroke(color: string, alpha = 1, width = this.weight): void {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha * 0.6;
    ctx.lineWidth = width + 3.2;
    ctx.strokeStyle = EDGE;
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** Fills the current path with an edge around it. */
  private fill(color: string, alpha = 1): void {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha * 0.6;
    ctx.lineWidth = 3.2;
    ctx.strokeStyle = EDGE;
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private font(size: number, weight: number): void {
    const ctx = this.ctx;
    ctx.font = `${weight} ${Math.round(size * this.type)}px ${MONO}`;
    ctx.textBaseline = 'alphabetic';
    if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '1px';
  }

  private text(s: string, x: number, y: number, color = this.inks.text, alpha = 1, align: CanvasTextAlign = 'left'): number {
    const ctx = this.ctx;
    ctx.textAlign = align;
    ctx.globalAlpha = alpha * 0.72;
    ctx.lineWidth = 5;
    // Coloured type always takes a dark edge; plain type takes whichever
    // edge sets it off from the background.
    ctx.strokeStyle = color === this.inks.text ? this.inks.textEdge : EDGE;
    ctx.strokeText(s, x, y);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
    ctx.globalAlpha = 1;
    return ctx.measureText(s).width;
  }

  private overlaps(box: Box): boolean {
    return this.taken.some((t) => box.x < t.x + t.w && box.x + box.w > t.x && box.y < t.y + t.h && box.y + box.h > t.y);
  }

  /**
   * A coloured key followed by a strong white value, e.g. "FLOW 0.82",
   * centred on (x, y). If that spot is taken it shifts up or down a line.
   */
  private reading(key: string, value: string, x: number, y: number, keyColor: string, alpha = 1, big = false): void {
    const ctx = this.ctx;
    const valueSize = big ? 34 : 27;
    this.font(20, 600);
    const keyWidth = key ? ctx.measureText(key).width + 12 * this.type : 0;
    this.font(valueSize, 700);
    const valueWidth = ctx.measureText(value).width;
    const width = keyWidth + valueWidth;
    const height = (valueSize + 8) * this.type;
    const box: Box = { x: x - width / 2 - 8, y: y - height + 6, w: width + 16, h: height + 4 };
    for (const step of [0, -1, 1, -2, 2, -3, 3]) {
      const moved = { ...box, y: box.y + step * (height + 4) };
      if (moved.x < 8 || moved.x + moved.w > this.w - 8 || moved.y < 8 || moved.y + moved.h > this.h - 8) continue;
      if (this.overlaps(moved)) continue;
      y += step * (height + 4);
      box.y = moved.y;
      break;
    }
    this.taken.push(box);
    const start = x - width / 2;
    if (key) {
      this.font(20, 600);
      this.text(key, start, y, keyColor, alpha);
    }
    this.font(valueSize, 700);
    this.text(value, start + keyWidth, y, this.inks.text, alpha);
  }

  /** A small filled square of pigment with a white edge. */
  private swatch(x: number, y: number, size: number, slot: number, alpha: number): void {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.inks.text;
    ctx.fillRect(x - 2, y - 2, size + 4, size + 4);
    ctx.fillStyle = this.inks.pigment[slot];
    ctx.fillRect(x, y, size, size);
    ctx.globalAlpha = 1;
  }

  /** A thick arc or line in a pigment's colour, backed with white so it shows on anything. */
  private pigmentStroke(slot: number | null, alpha: number, width: number): void {
    const ctx = this.ctx;
    ctx.lineCap = 'butt';
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width + 4;
    ctx.strokeStyle = this.inks.text;
    ctx.stroke();
    if (slot !== null) {
      ctx.lineWidth = width;
      ctx.strokeStyle = this.inks.pigment[slot];
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
  }

  private reticle(tip: XY, r: number, color: string, alpha: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, r, 0, Math.PI * 2);
    for (let k = 0; k < 4; k++) {
      const c = Math.cos((k * Math.PI) / 2);
      const s = Math.sin((k * Math.PI) / 2);
      ctx.moveTo(tip.x + c * (r - 6), tip.y + s * (r - 6));
      ctx.lineTo(tip.x + c * (r + 7), tip.y + s * (r + 7));
    }
    this.stroke(color, alpha);
  }

  // --- Frame furniture -----------------------------------------------------------

  private frameMarks(full: boolean): void {
    const ctx = this.ctx;
    const { w, h } = this;
    const inset = 36;
    const arm = 34;
    ctx.beginPath();
    for (const [cx, cy, sx, sy] of [
      [inset, inset, 1, 1],
      [w - inset, inset, -1, 1],
      [inset, h - inset, 1, -1],
      [w - inset, h - inset, -1, -1],
    ]) {
      ctx.moveTo(cx + sx * arm, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + sy * arm);
    }
    this.stroke(this.inks.text, 0.95);
    if (!full) return;

    // Rulers along the top and left edges, in the same 0..1 coordinates
    // printed beside the fingertips, and a faint lattice of crosses.
    ctx.beginPath();
    for (let i = 1; i < 40; i++) {
      const major = i % 4 === 0;
      const x = (w * i) / 40;
      const y = (h * i) / 40;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, major ? 16 : 8);
      ctx.moveTo(0, y);
      ctx.lineTo(major ? 16 : 8, y);
    }
    this.stroke(this.inks.text, 0.8, 1.4);
    this.font(14, 600);
    for (let i = 2; i < 10; i++) {
      const label = `.${i}`;
      this.text(label, (w * i) / 10 + 5, 15 + 14 * this.type, this.inks.text, 0.8);
      this.text(label, 22, (h * i) / 10 + 16 * this.type, this.inks.text, 0.8);
    }
    ctx.beginPath();
    for (let i = 1; i < 10; i++) {
      for (let j = 1; j < 10; j++) {
        const x = (w * i) / 10;
        const y = (h * j) / 10;
        ctx.moveTo(x - 5, y);
        ctx.lineTo(x + 5, y);
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x, y + 5);
      }
    }
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = this.inks.text;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private statusBlock(frame: OverlayFrame): void {
    const x = 70;
    let y = 104;
    const gap = 34 * this.type;
    const column = 110 * this.type;
    const rows: [string, string][] = [
      ['TRACK', frame.track],
      ['FRAME', `${Math.round(frame.fps)} FPS`],
      ['HANDS', String(this.handCount)],
      ['BACK', frame.background],
    ];
    this.taken.push({ x: x - 10, y: y - 30 * this.type, w: column + 250 * this.type, h: gap * (rows.length + 2) + 12 });
    for (const [key, value] of rows) {
      this.font(20, 600);
      this.text(key, x, y, this.inks.measure);
      this.font(24, 700);
      this.text(value, x + column, y);
      y += gap;
    }

    // The microphone: a level meter from -70 dB to full scale, with a tick
    // at the level a sound has to exceed to count as a clap or a snap.
    this.font(20, 600);
    this.text('MIC', x, y, this.inks.measure);
    const mic = frame.mic;
    if (mic.level === null || mic.threshold === null) {
      this.font(24, 700);
      this.text(mic.label, x + column, y);
    } else {
      const ctx = this.ctx;
      const width = 190 * this.type;
      const my = y - 8 * this.type;
      const at = (db: number) => x + column + width * Math.min(1, Math.max(0, (db + 70) / 70));
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(x + column, my);
      ctx.lineTo(x + column + width, my);
      this.stroke(this.inks.text, 0.6, 1.6);
      ctx.beginPath();
      ctx.moveTo(x + column, my);
      ctx.lineTo(at(mic.level), my);
      this.stroke(this.inks.measure, 1, 8);
      ctx.beginPath();
      ctx.moveTo(at(mic.threshold), my - 11);
      ctx.lineTo(at(mic.threshold), my + 11);
      this.stroke(this.inks.text, 1, 2.4);
      ctx.lineCap = 'round';
      this.font(18, 600);
      this.text(`${Math.round(mic.level)} DB`, x + column + width + 14, y, this.inks.text, 0.9);
    }
    y += gap;
    // A sound that was heard but that no hand accounts for.
    if (frame.unplaced && frame.unplaced.age >= 0 && frame.unplaced.age < 1.1) {
      this.font(18, 600);
      this.text(
        `HEARD +${Math.round(frame.unplaced.peak)} DB \u00b7 NO HANDS`,
        x,
        y,
        this.inks.text,
        0.75 * Math.min(1, (1.1 - frame.unplaced.age) * 3),
      );
    }

    // Which pigment belongs to which hand.
    const base = this.h - 60;
    let px = 70;
    const size = Math.round(18 * this.type);
    [frame.palette.first, frame.palette.second].forEach((pigment, i) => {
      this.font(20, 600);
      px += this.text(`H${i + 1}`, px, base, this.inks.hand[i]) + 12;
      this.swatch(px, base - size + 1, size, i, 1);
      px += size + 14;
      this.font(24, 700);
      px += this.text(pigment.name.toUpperCase(), px, base) + 44 * this.type;
    });
    this.taken.push({ x: 60, y: base - 34 * this.type, w: px - 60, h: 46 * this.type });
  }

  // --- One hand --------------------------------------------------------------------

  private bounds(p: XY[]): Box {
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const q of p) {
      left = Math.min(left, q.x);
      right = Math.max(right, q.x);
      top = Math.min(top, q.y);
      bottom = Math.max(bottom, q.y);
    }
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  /** Bones, joints, reticles, the bounding box and its tag. */
  private skeleton(track: Track, slot: number, full: boolean, frame: OverlayFrame): void {
    const ctx = this.ctx;
    const state = track.state!;
    const p = track.pts;
    const a = track.presence;
    const color = this.inks.hand[slot];

    ctx.beginPath();
    for (const [i, j] of BONES) {
      ctx.moveTo(p[i].x, p[i].y);
      ctx.lineTo(p[j].x, p[j].y);
    }
    this.stroke(color, a);

    // Joints: white nodes ringed in the hand's colour; the wrist is larger.
    for (let i = 0; i < 21; i++) {
      ctx.beginPath();
      ctx.arc(p[i].x, p[i].y, i === 0 ? 8 : 4.6, 0, Math.PI * 2);
      this.fill(this.inks.text, a);
      ctx.globalAlpha = a;
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Fingertips that are aimed at the water get a reticle; when ink or a
    // push is coming out of one, an arc around it shows how much.
    for (let f = 0; f < 5; f++) {
      const tip = p[TIPS[f]];
      const motion = frame.tip(slot, f);
      const live = motion !== null && motion.level > 0.02;
      const aimed = live || state.extended[f] || (state.pinching && f < 2);
      if (!aimed) continue;
      const r = f === 0 ? 14 : 19;
      this.reticle(tip, r, color, a);
      if (live && motion) {
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, r + 12, -Math.PI / 2, -Math.PI / 2 + Math.min(1, motion.level) * Math.PI * 2);
        this.pigmentStroke(state.gesture === 'open' ? null : slot, a, 7);
      }
    }

    // Bounding box as corner brackets, tagged with which hand it is and how
    // sure the tracker is.
    const pad = 30;
    const b = this.bounds(p);
    const x0 = b.x - pad;
    const y0 = b.y - pad;
    const x1 = b.x + b.w + pad;
    const y1 = b.y + b.h + pad;
    const arm = Math.min(30, (x1 - x0) / 4, (y1 - y0) / 4);
    ctx.beginPath();
    for (const [cx, cy, sx, sy] of [
      [x0, y0, 1, 1],
      [x1, y0, -1, 1],
      [x0, y1, 1, -1],
      [x1, y1, -1, -1],
    ]) {
      ctx.moveTo(cx + sx * arm, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + sy * arm);
    }
    this.stroke(color, a);
    if (!full) return;

    const side = state.side ? state.side.toUpperCase() : `HAND ${slot + 1}`;
    const tag = state.score === null ? `${side} SIM` : `${side} ${state.score.toFixed(2)}`;
    this.font(19, 700);
    const tw = ctx.measureText(tag).width + 20;
    const th = 30 * this.type;
    const tx = Math.max(8, Math.min(this.w - tw - 8, x0 - 1));
    const ty = Math.max(8, y0 - th - 7);
    ctx.globalAlpha = a;
    ctx.fillStyle = color;
    ctx.fillRect(tx, ty, tw, th);
    ctx.fillStyle = this.inks.onTag;
    ctx.textAlign = 'left';
    ctx.fillText(tag, tx + 10, ty + th - 9 * this.type);
    ctx.globalAlpha = 1;
    this.taken.push({ x: tx, y: ty, w: tw, h: th });
  }

  /** The block of live values that travels with a hand. */
  private readout(track: Track, slot: number, dt: number, frame: OverlayFrame): void {
    const ctx = this.ctx;
    const state = track.state!;
    const p = track.pts;
    const a = track.presence;
    const color = this.inks.hand[slot];
    const pigment = slot === 0 ? frame.palette.first : frame.palette.second;
    const held = frame.held(slot);
    const t = this.type;
    const width = 268 * t;
    const lineGap = 38 * t;
    const lines = 3;
    const height = lineGap * lines + 22;

    // Sit below the wrist, leaning to the little-finger side; if the frame
    // edge pushes it back onto the hand, go out to the side instead.
    const outX = p[17].x - p[5].x;
    const outY = p[17].y - p[5].y;
    const outL = Math.hypot(outX, outY) || 1;
    const downX = p[0].x - p[9].x;
    const downY = p[0].y - p[9].y;
    const downL = Math.hypot(downX, downY) || 1;
    let gx = p[0].x + (outX / outL) * 90 + (downX / downL) * 60;
    let gy = p[0].y + (outY / outL) * 90 + (downY / downL) * 60;
    if (outX < 0) gx -= width;
    const clampX = (v: number) => Math.min(this.w - 66 - width, Math.max(66, v));
    gx = clampX(gx);
    gy = Math.min(this.h - 110 - height, Math.max(250, gy));
    const b = this.bounds(p);
    const pad = 44;
    if (gx < b.x + b.w + pad && gx + width > b.x - pad && gy < b.y + b.h + pad && gy + height > b.y - pad) {
      const toLeft = b.x - pad - width;
      const toRight = b.x + b.w + pad;
      const fits = (v: number) => v >= 66 && v + width <= this.w - 66;
      if (outX < 0 && fits(toLeft)) gx = toLeft;
      else if (fits(toRight)) gx = toRight;
      else if (fits(toLeft)) gx = toLeft;
      gx = clampX(gx);
    }
    if (!track.label || track.presence < 0.05) track.label = { x: gx, y: gy };
    const glide = 1 - Math.exp(-dt / 0.14);
    track.label.x += (gx - track.label.x) * glide;
    track.label.y += (gy - track.label.y) * glide;
    const x = Math.round(track.label.x);
    const y = Math.round(track.label.y);
    this.taken.push({ x: x - 8, y: y - 6, w: width + 16, h: height + 6 });

    // Leader from the wrist to the nearer end of the rule above the text.
    const nearX = Math.abs(p[0].x - x) < Math.abs(p[0].x - (x + width)) ? x : x + width;
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    ctx.lineTo(nearX, y);
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y);
    this.stroke(color, a);

    const column = 98 * t;
    let ty = y + lineGap;
    const size = Math.round(18 * t);
    this.font(20, 600);
    this.text('INK', x, ty, color, a);
    this.swatch(x + column, ty - size + 1, size, slot, a);
    this.font(24, 700);
    this.text(pigment.name.toUpperCase(), x + column + size + 14, ty, this.inks.text, a);

    ty += lineGap;
    const fingers = state.extended.slice(1).filter(Boolean).length;
    const stateName = STATE_NAMES[state.gesture] + (state.gesture === 'point' ? ` ×${fingers}` : '');
    this.font(20, 600);
    this.text('STATE', x, ty, color, a);
    this.font(27, 700);
    this.text(stateName, x + column, ty, this.inks.text, a);

    // Flow while drawing; charge while a pinch is held.
    ty += lineGap;
    const charging = held !== null && held.charge > 0;
    const level = charging ? held.charge : Math.min(1, frame.handLevel(slot));
    this.font(20, 600);
    this.text(charging ? 'CHARGE' : 'FLOW', x, ty, color, a);
    this.font(27, 700);
    const used = column + this.text(level.toFixed(2), x + column, ty, this.inks.text, a);
    const g0 = x + used + 16;
    ctx.beginPath();
    ctx.moveTo(g0, ty - 9 * t);
    ctx.lineTo(x + width, ty - 9 * t);
    this.stroke(this.inks.text, a * 0.6, 1.6);
    if (level > 0.01) {
      ctx.beginPath();
      ctx.moveTo(g0, ty - 9 * t);
      ctx.lineTo(g0 + (x + width - g0) * level, ty - 9 * t);
      this.pigmentStroke(state.gesture === 'open' ? null : slot, a, 7);
    }
  }

  /** Everything measured on one hand: pinch gap, lean, fingertip speed and position. */
  private measures(track: Track, slot: number, frame: OverlayFrame): void {
    const ctx = this.ctx;
    const state = track.state!;
    const p = track.pts;
    const a = track.presence;
    const green = this.inks.measure;
    const color = this.inks.hand[slot];

    // The fastest fingertip that is putting something into the water gets
    // the full treatment; the others get an arrow only.
    let lead: { motion: Motion; tip: XY; id: number } | null = null;
    for (let f = 0; f < 5; f++) {
      const motion = frame.tip(slot, f);
      if (!motion || motion.level <= 0.02) continue;
      const tip = p[TIPS[f]];
      this.arrow(tip, motion, a);
      if (!lead || motion.speed > lead.motion.speed) lead = { motion, tip, id: TIPS[f] };
    }

    // Landmark numbers beside the straight fingertips.
    this.font(16, 600);
    for (let f = 0; f < 5; f++) {
      if (!state.extended[f] && !(lead && lead.id === TIPS[f])) continue;
      const tip = p[TIPS[f]];
      this.text(String(TIPS[f]).padStart(2, '0'), tip.x + 26, tip.y - 22, color, a);
    }

    if (lead) {
      const { motion, tip } = lead;
      // Crosshair out to the rulers, with the tip's position.
      ctx.setLineDash([2, 10]);
      ctx.beginPath();
      ctx.moveTo(tip.x, 20);
      ctx.lineTo(tip.x, tip.y - 34);
      ctx.moveTo(20, tip.y);
      ctx.lineTo(tip.x - 34, tip.y);
      this.stroke(color, a * 0.75, 1.6);
      ctx.setLineDash([]);
      this.font(16, 600);
      this.text(`x ${(tip.x / this.w).toFixed(3)}`, tip.x + 8, 62 * this.type, color, a);
      this.text(`y ${(tip.y / this.h).toFixed(3)}`, 44, tip.y - 10, color, a);

      // Speed at the arrow head, and the flow it produces on the other side.
      if (motion.speed > 0.08) {
        const ux = motion.vx / motion.speed;
        const uy = motion.vy / motion.speed;
        const reach = 34 + Math.min(210, 44 + motion.speed * 150);
        this.reading('V', motion.speed.toFixed(2), tip.x + ux * (reach + 70 * this.type), tip.y + uy * (reach + 34 * this.type) + 9, green, a);
        const fx = tip.x - ux * 30 - uy * 96 * this.type * (ux >= 0 ? 1 : -1);
        const fy = tip.y - uy * 30 - Math.abs(ux) * 74 * this.type - 30 * this.type * Math.abs(uy);
        this.reading('FLOW', motion.level.toFixed(2), fx, fy, color, a, true);
      } else {
        this.reading('FLOW', motion.level.toFixed(2), tip.x, tip.y - 62 * this.type, color, a, true);
      }
    }

    // The gap between thumb and index, measured like a caliper. A fist has
    // no gap to measure, and an open hand is busy stirring.
    const held = frame.held(slot);
    if (state.gesture === 'snap') {
      // Thumb against the middle finger: armed for a snap.
      const thumb = p[4];
      const middle = p[12];
      ctx.beginPath();
      ctx.moveTo(thumb.x, thumb.y);
      ctx.lineTo(middle.x, middle.y);
      this.stroke(this.inks.text, a, this.weight * 2);
      ctx.beginPath();
      ctx.arc((thumb.x + middle.x) / 2, (thumb.y + middle.y) / 2, 40, 0, Math.PI * 2);
      this.stroke(green, a);
      this.reading('SNAP', state.snapGap.toFixed(2), (thumb.x + middle.x) / 2, (thumb.y + middle.y) / 2 - 62 * this.type, green, a);
    } else if (state.gesture !== 'rest' && state.gesture !== 'open') {
      const thumb = p[4];
      const index = p[8];
      const dx = index.x - thumb.x;
      const dy = index.y - thumb.y;
      const len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len;
      let ny = dx / len;
      const snap = track.sinceDrop < 0.45;
      ctx.beginPath();
      ctx.moveTo(thumb.x, thumb.y);
      ctx.lineTo(index.x, index.y);
      for (const end of [thumb, index]) {
        ctx.moveTo(end.x - nx * 13, end.y - ny * 13);
        ctx.lineTo(end.x + nx * 13, end.y + ny * 13);
      }
      // The caliper flashes white and heavy as it snaps shut.
      this.stroke(snap ? this.inks.text : green, a, snap ? this.weight * 2 : this.weight);

      const mx = (thumb.x + index.x) / 2;
      const my = (thumb.y + index.y) / 2;
      if ((mx + nx - p[0].x) ** 2 + (my + ny - p[0].y) ** 2 < (mx - nx - p[0].x) ** 2 + (my - ny - p[0].y) ** 2) {
        nx = -nx;
        ny = -ny;
      }
      const away = 66 * this.type;
      if (!state.pinching) {
        this.reading('PINCH', state.pinchGap.toFixed(2), mx + nx * away, my + ny * away + 9, green, a);
      } else if (held && held.charge > 0) {
        // A held pinch: a dial that fills as it charges.
        ctx.beginPath();
        ctx.arc(mx, my, 46, 0, Math.PI * 2);
        this.stroke(this.inks.text, a * 0.7, 1.6);
        ctx.beginPath();
        ctx.arc(mx, my, 46, -Math.PI / 2, -Math.PI / 2 + held.charge * Math.PI * 2);
        this.pigmentStroke(slot, a, 8);
        this.reading('CHARGE', held.charge.toFixed(2), mx + nx * (away + 44), my + ny * (away + 44) + 9, green, a, true);
      } else {
        this.reading('', 'DROP', mx + nx * (away + 24), my + ny * (away + 24) + 9, green, a, true);
      }
    }

    // The ring thrown off when a drop is released.
    if (track.sinceDrop < 0.8) {
      const e = track.sinceDrop / 0.8;
      const out = 1 - (1 - e) * (1 - e);
      ctx.beginPath();
      ctx.arc(track.dropAt.x, track.dropAt.y, 24 + 130 * out, 0, Math.PI * 2);
      this.stroke(green, (1 - e) * a, 4);
    }

    // How far the hand leans from upright, as an arc at the wrist.
    const ax = p[9].x - p[0].x;
    const ay = p[9].y - p[0].y;
    if (Math.hypot(ax, ay) > 20) {
      const angle = Math.atan2(ay, ax);
      const up = -Math.PI / 2;
      let lean = angle - up;
      while (lean > Math.PI) lean -= Math.PI * 2;
      while (lean < -Math.PI) lean += Math.PI * 2;
      const r = 66;
      ctx.setLineDash([3, 9]);
      ctx.beginPath();
      ctx.moveTo(p[0].x, p[0].y - 14);
      ctx.lineTo(p[0].x, p[0].y - r - 24);
      this.stroke(green, a * 0.9);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(p[0].x, p[0].y, r, up, angle, lean < 0);
      this.stroke(green, a);
      const side = lean < 0 ? 1 : -1;
      this.reading('', `${Math.round((lean * 180) / Math.PI)}°`, p[0].x + side * 58 * this.type, p[0].y - r - 30, green, a);
    }
  }

  /** Velocity arrow from a fingertip. */
  private arrow(tip: XY, motion: Motion, alpha: number): void {
    if (motion.speed < 0.06) return;
    const ctx = this.ctx;
    const length = Math.min(210, 44 + motion.speed * 150);
    const ux = motion.vx / motion.speed;
    const uy = motion.vy / motion.speed;
    const ex = tip.x + ux * (34 + length);
    const ey = tip.y + uy * (34 + length);
    ctx.beginPath();
    ctx.moveTo(tip.x + ux * 34, tip.y + uy * 34);
    ctx.lineTo(ex, ey);
    ctx.moveTo(ex - ux * 16 - uy * 9, ey - uy * 16 + ux * 9);
    ctx.lineTo(ex, ey);
    ctx.lineTo(ex - ux * 16 + uy * 9, ey - uy * 16 - ux * 9);
    this.stroke(this.inks.measure, alpha);
  }

  /** A measuring line between the two hands, with what it sets. */
  private spanLine(frame: OverlayFrame): void {
    const [a, b] = this.tracks;
    if (!frame.span || !a.state || !b.state || a.pts.length === 0 || b.pts.length === 0) return;
    const alpha = Math.min(a.presence, b.presence);
    if (alpha < 0.05) return;
    const ctx = this.ctx;
    const green = this.inks.measure;
    const pa = { x: (a.pts[0].x + a.pts[9].x) / 2, y: (a.pts[0].y + a.pts[9].y) / 2 };
    const pb = { x: (b.pts[0].x + b.pts[9].x) / 2, y: (b.pts[0].y + b.pts[9].y) / 2 };
    ctx.setLineDash([3, 11]);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    this.stroke(green, alpha * 0.95);
    ctx.setLineDash([]);
    for (const p of [pa, pb]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6.5, 0, Math.PI * 2);
      this.fill(green, alpha);
    }
    // Both readings sit above the middle of the line, clear of the hands.
    const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
    let nx = -(pb.y - pa.y) / len;
    let ny = (pb.x - pa.x) / len;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    const mx = (pa.x + pb.x) / 2 + nx * 74 * this.type;
    const my = (pa.y + pb.y) / 2 + ny * 74 * this.type;
    this.reading('SPAN', frame.span.distance.toFixed(2), mx, my - 8, green, alpha);
    this.reading('WIDTH', `×${frame.span.width.toFixed(2)}`, mx, my + 32 * this.type, green, alpha);
  }

  /** One-off events: claps, and both hands pinching at once. */
  private moments(frame: OverlayFrame): void {
    const ctx = this.ctx;
    const green = this.inks.measure;
    const rings = (x: number, y: number, e: number, reach: number) => {
      const out = 1 - (1 - e) * (1 - e);
      for (const lag of [0, 0.18]) {
        ctx.beginPath();
        ctx.arc(x, y, 30 + reach * Math.max(0, out - lag), 0, Math.PI * 2);
        this.stroke(green, (1 - e) * 0.95, 4);
      }
    };

    const clap = frame.clap;
    if (clap && clap.age >= 0) {
      const x = clap.x * this.w;
      const y = clap.y * this.h;
      if (clap.count === 1 && clap.windowLeft > 0) {
        // The first clap of a pair, with a bar that runs down while a
        // second one would still count.
        if (clap.age < 0.5) rings(x, y, clap.age / 0.5, 110);
        this.reading('CLAP', clap.peak === undefined ? '1/2' : `1/2 +${Math.round(clap.peak)} DB`, x, y - 64 * this.type, green, 1, true);
        const half = 90 * this.type;
        const by = y - 44 * this.type;
        ctx.beginPath();
        ctx.moveTo(x - half, by);
        ctx.lineTo(x + half, by);
        this.stroke(this.inks.text, 0.6, 1.6);
        ctx.lineCap = 'butt';
        ctx.beginPath();
        ctx.moveTo(x - half, by);
        ctx.lineTo(x - half + 2 * half * clap.windowLeft, by);
        this.stroke(green, 1, 7);
        ctx.lineCap = 'round';
      } else if (clap.count === 2 && clap.age < 1.2) {
        const e = clap.age / 1.2;
        rings(x, y, e, 340);
        this.reading('CLAP', '2/2 SWITCH', x, y - 64 * this.type, green, Math.min(1, (1 - e) * 2.2), true);
      }
    }

    const snap = frame.snap;
    if (snap && snap.age >= 0 && snap.age < 1.1) {
      const e = snap.age / 1.1;
      rings(snap.x * this.w, snap.y * this.h, e, 340);
      this.reading('SNAP', `+${Math.round(snap.peak)} DB`, snap.x * this.w, snap.y * this.h - 64 * this.type, green, Math.min(1, (1 - e) * 2.2), true);
    }

    const twin = frame.twin;
    if (twin && twin.age >= 0 && twin.age < 0.9) {
      const e = twin.age / 0.9;
      rings(twin.x * this.w, twin.y * this.h, e, 330);
      this.reading('', 'TWIN DROP', twin.x * this.w, twin.y * this.h - 58 * this.type, green, Math.min(1, (1 - e) * 2.2), true);
    }
  }

  /** A mouse or touch point, marked like a single fingertip. */
  private pointer(motion: Motion, full: boolean): void {
    if (motion.level < 0.02) return;
    const ctx = this.ctx;
    const tip = { x: motion.x * this.w, y: motion.y * this.h };
    const color = this.inks.hand[motion.pigment];
    this.reticle(tip, 19, color, 1);
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 31, -Math.PI / 2, -Math.PI / 2 + Math.min(1, motion.level) * Math.PI * 2);
    this.pigmentStroke(motion.pigment, 1, 7);
    if (!full) return;
    this.arrow(tip, motion, 1);
    const side = motion.vy < 0 ? 1 : -1;
    this.reading('FLOW', motion.level.toFixed(2), tip.x, tip.y + side * 70 * this.type + 9, color, 1, true);
    if (motion.speed > 0.08) {
      const ux = motion.vx / motion.speed;
      const uy = motion.vy / motion.speed;
      const reach = 34 + Math.min(210, 44 + motion.speed * 150);
      this.reading('V', motion.speed.toFixed(2), tip.x + ux * (reach + 70 * this.type), tip.y + uy * (reach + 34 * this.type) + 9, this.inks.measure, 1);
    }
  }
}
