// A short choreography of two imaginary hands, used by ?demo=1 so the piece
// can be shown without a camera.
//
// The demo does not call the brush. It poses a simple 21-joint hand model,
// and the resulting landmarks go through the same gesture reading as a real
// tracked hand, so what you see is the real pipeline minus the camera.

import { Onset } from './audio';
import { HandMemory, HandState, Point, Point3, interpret, newHandMemory } from './hands';

type P = [number, number];
type Pose = P[];

// --- Hand model ------------------------------------------------------------------
// Joints in hand units: the wrist is the origin, the middle knuckle sits one
// unit up, the thumb is on the +x side.

/** A straight finger: knuckle, then three joints along one direction. */
function ray(knuckle: P, degrees: number, bones: [number, number, number]): P[] {
  const a = (degrees * Math.PI) / 180;
  const out: P[] = [knuckle];
  let reach = 0;
  for (const bone of bones) {
    reach += bone;
    out.push([knuckle[0] + Math.sin(a) * reach, knuckle[1] + Math.cos(a) * reach]);
  }
  return out;
}

const WRIST: P = [0, 0];
const KNUCKLES: P[] = [
  [0.26, 0.95],
  [0, 1],
  [-0.23, 0.93],
  [-0.42, 0.8],
];
const BONES: [number, number, number][] = [
  [0.43, 0.28, 0.24],
  [0.47, 0.31, 0.26],
  [0.43, 0.28, 0.24],
  [0.33, 0.21, 0.19],
];
const CURLED: P[][] = [
  [KNUCKLES[0], [0.3, 1.24], [0.28, 1.02], [0.25, 0.84]],
  [KNUCKLES[1], [0.0, 1.3], [0.02, 1.05], [0.04, 0.86]],
  [KNUCKLES[2], [-0.25, 1.22], [-0.22, 0.99], [-0.19, 0.82]],
  [KNUCKLES[3], [-0.46, 1.05], [-0.41, 0.86], [-0.36, 0.73]],
];
const HALF_CURLED: P[][] = [
  [KNUCKLES[1], [0.02, 1.42], [0.1, 1.62], [0.18, 1.52]],
  [KNUCKLES[2], [-0.24, 1.32], [-0.17, 1.5], [-0.09, 1.42]],
  [KNUCKLES[3], [-0.46, 1.08], [-0.41, 1.22], [-0.35, 1.16]],
];
const THUMB_FOLDED: P[] = [
  [0.26, 0.22],
  [0.42, 0.5],
  [0.34, 0.7],
  [0.2, 0.8],
];

const POSES = {
  rest: [WRIST, ...THUMB_FOLDED, ...CURLED.flat()],
  point: [WRIST, ...THUMB_FOLDED, ...ray(KNUCKLES[0], 5, BONES[0]), ...CURLED.slice(1).flat()],
  open: [
    WRIST,
    ...ray([0.3, 0.2], 42, [0.36, 0.3, 0.25]),
    ...ray(KNUCKLES[0], 11, BONES[0]),
    ...ray(KNUCKLES[1], 0, BONES[1]),
    ...ray(KNUCKLES[2], -10, BONES[2]),
    ...ray(KNUCKLES[3], -24, BONES[3]),
  ],
  // Thumb and index held apart, about to pinch.
  ready: [
    WRIST,
    [0.3, 0.22],
    [0.56, 0.48],
    [0.76, 0.76],
    [0.86, 1.08],
    KNUCKLES[0],
    [0.34, 1.36],
    [0.52, 1.58],
    [0.68, 1.5],
    ...HALF_CURLED.flat(),
  ],
  pinch: [
    WRIST,
    [0.3, 0.22],
    [0.54, 0.52],
    [0.66, 0.88],
    [0.68, 1.26],
    KNUCKLES[0],
    [0.34, 1.36],
    [0.52, 1.56],
    [0.66, 1.44],
    ...HALF_CURLED.flat(),
  ],
  // Thumb pressed against the middle finger, about to snap.
  snapReady: [
    WRIST,
    [0.3, 0.22],
    [0.5, 0.5],
    [0.56, 0.82],
    [0.46, 1.1],
    KNUCKLES[0],
    [0.33, 1.34],
    [0.44, 1.52],
    [0.52, 1.42],
    KNUCKLES[1],
    [0.1, 1.38],
    [0.3, 1.42],
    [0.44, 1.18],
    ...HALF_CURLED.slice(1).flat(),
  ],
  // Just after: the middle finger has struck the palm, the thumb has slid on.
  snapDone: [
    WRIST,
    [0.3, 0.22],
    [0.54, 0.5],
    [0.7, 0.8],
    [0.74, 1.1],
    KNUCKLES[0],
    [0.33, 1.34],
    [0.44, 1.52],
    [0.52, 1.42],
    KNUCKLES[1],
    [0.06, 1.3],
    [0.14, 1.08],
    [0.16, 0.84],
    ...HALF_CURLED.slice(1).flat(),
  ],
} satisfies Record<string, Pose>;
type PoseName = keyof typeof POSES;

// The spot on the hand that follows the choreographed path in each pose.
const ANCHORS: Record<PoseName, P> = {
  rest: [0.1, 0.95],
  point: POSES.point[8],
  open: [0, 0.55],
  ready: [0.77, 1.29],
  pinch: [0.67, 1.35],
  snapReady: [0.45, 1.14],
  snapDone: [0.45, 1.14],
};


// --- Choreography ----------------------------------------------------------------

interface Act {
  pose: 'point' | 'open' | 'pinch' | 'snap';
  start: number;
  end: number;
  path: P[];
  /** For a pinch: when it closes and when it opens again. For a snap: when it cracks. */
  close?: number;
  release?: number;
}

const LOOP = 22.5;
// The water is cleared near the end of each pass, as the C key would.
const CLEAR_AT = 20.3;

// The demo has no microphone, so it supplies the sounds itself: one at the
// snap and one at each clap. They go through the same checks against the
// hands as real sounds would.
const SOUNDS = [15.95, 19.28, 19.78];

// Positions are fractions of the stage, written for the landscape frame.
const SCRIPT: { home: P; elbow: P; acts: Act[] }[] = [
  {
    home: [0.24, 1.02],
    elbow: [0.16, 1.7],
    acts: [
      {
        pose: 'point',
        start: 0.5,
        end: 5.2,
        path: [
          [0.1, 0.34],
          [0.2, 0.2],
          [0.36, 0.2],
          [0.46, 0.38],
          [0.38, 0.54],
          [0.24, 0.56],
          [0.2, 0.72],
          [0.36, 0.8],
        ],
      },
      { pose: 'pinch', start: 9.6, end: 10.8, path: [[0.3, 0.24]] },
      {
        pose: 'open',
        start: 11.9,
        end: 14.3,
        path: [
          [0.22, 0.74],
          [0.36, 0.6],
          [0.5, 0.52],
          [0.62, 0.4],
        ],
      },
      // A snap, which switches the background.
      { pose: 'snap', start: 15.2, end: 16.4, path: [[0.34, 0.4]], close: 15.95 },
      // Both hands pinch at the same moment.
      { pose: 'pinch', start: 16.9, end: 18.2, path: [[0.42, 0.42]], close: 17.5 },
      // A double clap, which switches the background back: both hands fly
      // together at the middle of the frame, part a little, and meet again.
      {
        pose: 'open',
        start: 18.9,
        end: 19.26,
        path: [
          [0.36, 0.56],
          [0.474, 0.5],
        ],
      },
      {
        pose: 'open',
        start: 19.3,
        end: 19.48,
        path: [
          [0.474, 0.5],
          [0.42, 0.5],
        ],
      },
      {
        pose: 'open',
        start: 19.52,
        end: 19.76,
        path: [
          [0.42, 0.5],
          [0.474, 0.5],
        ],
      },
    ],
  },
  {
    home: [0.76, 1.02],
    elbow: [0.84, 1.7],
    acts: [
      {
        pose: 'point',
        start: 3.4,
        end: 7.8,
        path: [
          [0.9, 0.6],
          [0.82, 0.4],
          [0.68, 0.22],
          [0.56, 0.28],
          [0.54, 0.48],
          [0.64, 0.62],
          [0.78, 0.6],
          [0.86, 0.74],
        ],
      },
      { pose: 'pinch', start: 8.6, end: 9.8, path: [[0.72, 0.22]] },
      // A pinch held for two seconds, so it charges before it lets go.
      { pose: 'pinch', start: 12.5, end: 15.3, path: [[0.74, 0.24]], close: 12.9, release: 14.9 },
      { pose: 'pinch', start: 16.9, end: 18.2, path: [[0.58, 0.42]], close: 17.5 },
      {
        pose: 'open',
        start: 18.9,
        end: 19.26,
        path: [
          [0.64, 0.56],
          [0.526, 0.5],
        ],
      },
      {
        pose: 'open',
        start: 19.3,
        end: 19.48,
        path: [
          [0.526, 0.5],
          [0.58, 0.5],
        ],
      },
      {
        pose: 'open',
        start: 19.52,
        end: 19.76,
        path: [
          [0.58, 0.5],
          [0.526, 0.5],
        ],
      },
    ],
  },
];

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Position on a Catmull-Rom spline through `pts`, u in 0..1. */
function along(pts: P[], u: number): P {
  if (pts.length === 1) return pts[0];
  const n = pts.length - 1;
  const s = Math.min(Math.max(u, 0), 0.99999) * n;
  const i = Math.floor(s);
  const t = s - i;
  const p0 = pts[Math.max(i - 1, 0)];
  const p1 = pts[i];
  const p2 = pts[Math.min(i + 1, n)];
  const p3 = pts[Math.min(i + 2, n)];
  const axis = (k: 0 | 1) =>
    0.5 *
    (2 * p1[k] +
      (p2[k] - p0[k]) * t +
      (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t +
      (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * t * t * t);
  return [axis(0), axis(1)];
}

/** Slow in, slow out, with a little unevenness so the hand feels alive. */
function pace(u: number): number {
  const e = u * u * (3 - 2 * u);
  return e + 0.035 * Math.sin(u * Math.PI * 5) * Math.sin(u * Math.PI);
}

/** Where the hand's anchor should be at time t. */
function target(home: P, acts: Act[], t: number): P {
  const mix = (a: P, b: P, u: number): P => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  for (let i = 0; i < acts.length; i++) {
    const act = acts[i];
    if (t >= act.start && t <= act.end) return along(act.path, pace((t - act.start) / (act.end - act.start)));
    if (t < act.start) {
      // Travelling in: from the previous act's end, or from home.
      const from = i === 0 ? home : along(acts[i - 1].path, 1);
      const freeFrom = i === 0 ? 0 : acts[i - 1].end + 0.2;
      const leave = Math.max(freeFrom, act.start - 1.7);
      return mix(from, act.path[0], smooth(leave, act.start - 0.25, t));
    }
  }
  const last = acts[acts.length - 1];
  return mix(along(last.path, 1), home, smooth(last.end + 0.4, last.end + 2.4, t));
}

/** How much of each pose the hand is in at time t. */
function poseWeights(acts: Act[], t: number): Record<PoseName, number> {
  const w: Record<PoseName, number> = { rest: 0, point: 0, open: 0, ready: 0, pinch: 0, snapReady: 0, snapDone: 0 };
  for (const act of acts) {
    const present = smooth(act.start - 0.35, act.start - 0.05, t) * (1 - smooth(act.end, act.end + 0.3, t));
    if (act.pose === 'pinch') {
      const close = act.close ?? (act.start + act.end) / 2;
      const release = act.release ?? close + 0.22;
      const closed = smooth(close - 0.2, close, t) * (1 - smooth(release, release + 0.23, t));
      w.pinch += present * closed;
      w.ready += present * (1 - closed);
    } else if (act.pose === 'snap') {
      // The finger lets go in an instant.
      const crack = act.close ?? (act.start + act.end) / 2;
      const done = smooth(crack - 0.02, crack + 0.03, t);
      w.snapDone += present * done;
      w.snapReady += present * (1 - done);
    } else {
      w[act.pose] += present;
    }
  }
  // Acts that follow straight on from each other overlap as they blend.
  const names = Object.keys(w) as PoseName[];
  const total = names.reduce((sum, name) => sum + w[name], 0);
  if (total > 1) for (const name of names) w[name] /= total;
  w.rest = Math.max(0, 1 - Math.min(1, total));
  return w;
}

export class Demo {
  private lastTime = 0;
  private loops = 0;
  private readonly memory: HandMemory[] = [newHandMemory(), newHandMemory()];

  /** Stage width over height; set again if the stage changes shape. */
  stageAspect = 16 / 9;
  private pending: Onset[] = [];

  constructor(private readonly clear: () => void) {}

  /** The made-up sounds since the last call, on the same clock as `update`. */
  sounds(): Onset[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** The two synthetic hands at this moment. */
  update(time: number): HandState[] {
    const t = time % LOOP;
    if (t < this.lastTime) this.loops++;
    for (const at of SOUNDS) {
      if (this.lastTime < at && t >= at) this.pending.push({ time: time - (t - at), peak: 30 });
    }
    if (this.lastTime < CLEAR_AT && t >= CLEAR_AT) this.clear();
    this.lastTime = t;
    // Every other pass is mirrored so the loop does not repeat exactly.
    const flip = this.loops % 2 === 1;
    // A hand fills more of a wide frame than of a tall one.
    const handSize = this.stageAspect > 1 ? 0.19 : 0.1; // stage heights per hand unit

    return SCRIPT.map((hand, index) => {
      const slot = index as 0 | 1;
      const side = slot === 0 ? 1 : -1; // which way the thumb points
      const weights = poseWeights(hand.acts, t);
      const names = Object.keys(weights) as PoseName[];

      const local: P[] = POSES.rest.map((_, j) => {
        let x = 0;
        let y = 0;
        for (const name of names) {
          x += POSES[name][j][0] * weights[name];
          y += POSES[name][j][1] * weights[name];
        }
        return [x, y];
      });
      let ax = 0;
      let ay = 0;
      for (const name of names) {
        ax += ANCHORS[name][0] * weights[name];
        ay += ANCHORS[name][1] * weights[name];
      }

      // The hand points away from its elbow, like a forearm reaching in.
      const [tx, ty] = target(hand.home, hand.acts, t);
      const ux = (tx - hand.elbow[0]) * this.stageAspect;
      const uy = ty - hand.elbow[1];
      const ul = Math.hypot(ux, uy) || 1;
      const up: P = [ux / ul, uy / ul];
      const right: P = [-up[1], up[0]];

      const place = (lx: number, ly: number, j: number): Point => {
        const dx = (lx - ax) * side;
        const dy = ly - ay;
        // A faint tremor, as real tracking would have.
        const jx = 0.0011 * Math.sin(time * 9.1 + j * 1.7 + slot * 3);
        const jy = 0.0011 * Math.cos(time * 7.7 + j * 2.3 + slot);
        const x = tx + (handSize * (dx * right[0] + dy * up[0])) / this.stageAspect + jx;
        const y = ty + handSize * (dx * right[1] + dy * up[1]) + jy;
        return { x: flip ? 1 - x : x, y };
      };

      const stage = local.map(([lx, ly], j) => place(lx, ly, j));
      const shape: Point3[] = local.map(([lx, ly]) => ({ x: lx, y: ly, z: 0 }));
      return interpret(slot, stage, shape, this.stageAspect, this.memory[slot]);
    });
  }
}
