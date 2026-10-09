// Feeds made-up palm tracks to the clap reader and checks what it decides.
// Real trackers lose or merge hands at the moment they touch, so most cases
// here include dropouts.
//
//     node tools/clap-test.ts

import { GestureReader } from '../src/gestures.ts';

const ASPECT = 16 / 9;
const SIZE = 0.19; // hand size in stage heights

interface Frame {
  /** x of each palm as a fraction of the stage width, or null when the tracker has lost it. */
  a: [number, number] | null;
  b: [number, number] | null;
  pinching?: boolean;
  /** Hands half the usual size, as when standing back from the camera. */
  small?: boolean;
}

function hand(slot: 0 | 1, at: [number, number], pinching: boolean, small: boolean): any {
  return {
    slot,
    palm: { x: at[0], y: at[1] },
    size: small ? SIZE / 2 : SIZE,
    pinching,
    pinched: false,
    pinchPoint: { x: at[0], y: at[1] },
    gesture: pinching ? 'pinch' : 'open',
  };
}

/** Runs a track and returns how many first and second claps were reported. */
function run(frames: Frame[], fps: number): { first: number; double: number } {
  const reader = new GestureReader();
  let first = 0;
  let double = 0;
  frames.forEach((frame, i) => {
    const hands = [];
    if (frame.a) hands.push(hand(0, frame.a, !!frame.pinching, !!frame.small));
    if (frame.b) hands.push(hand(1, frame.b, !!frame.pinching, !!frame.small));
    const events = reader.update(hands, 10 + i / fps, ASPECT);
    if (events.clap?.count === 1) first++;
    if (events.clap?.count === 2) double++;
  });
  return { first, double };
}

// --- Building blocks -------------------------------------------------------------
// `half` is half the distance between the palms, as a fraction of stage width.

let seed = 7;
function noise(amount: number): number {
  seed = (seed * 16807) % 2147483647;
  return ((seed / 2147483647) * 2 - 1) * amount;
}

function both(half: number, jitter = 0, y = 0.5, dyb = 0): Frame {
  return { a: [0.5 - half + noise(jitter), y + noise(jitter)], b: [0.5 + half + noise(jitter), y + dyb + noise(jitter)] };
}
const none: Frame = { a: null, b: null };

/** Palms moving from one half-distance to another over a time, with ease in. */
function move(from: number, to: number, seconds: number, fps: number, jitter = 0): Frame[] {
  const n = Math.max(1, Math.round(seconds * fps));
  return Array.from({ length: n }, (_, i) => {
    const u = (i + 1) / n;
    return both(from + (to - from) * u * u, jitter);
  });
}
const hold = (half: number, seconds: number, fps: number, jitter = 0): Frame[] =>
  Array.from({ length: Math.round(seconds * fps) }, () => both(half, jitter));
const lost = (frames: number): Frame[] => Array.from({ length: frames }, () => none);
const oneLost = (frames: number, half: number): Frame[] =>
  Array.from({ length: frames }, () => ({ a: [0.5 - half, 0.5] as [number, number], b: null }));

const WIDE = 0.16; // palms 0.32 of the width apart: about 3 hand sizes
const NEAR = 0.085; // about 1.6 hand sizes
const SHUT = 0.022; // touching

interface Case {
  name: string;
  fps: number;
  frames: (fps: number) => Frame[];
  expect: { double: number; first?: number };
}

const cases: Case[] = [
  {
    name: 'double clap, hands seen throughout',
    fps: 30,
    frames: (f) => [
      ...hold(WIDE, 0.4, f),
      ...move(WIDE, SHUT, 0.2, f),
      ...hold(SHUT, 0.07, f),
      ...move(SHUT, NEAR, 0.17, f),
      ...move(NEAR, SHUT, 0.17, f),
      ...hold(SHUT, 0.1, f),
      ...move(SHUT, WIDE, 0.3, f),
      ...hold(WIDE, 0.4, f),
    ],
    expect: { double: 1 },
  },
  {
    name: 'double clap, both hands lost at each contact',
    fps: 30,
    frames: (f) => [
      ...hold(WIDE, 0.4, f),
      ...move(WIDE, 0.05, 0.17, f),
      ...lost(3),
      ...move(0.06, NEAR, 0.1, f),
      ...move(NEAR, 0.05, 0.1, f),
      ...lost(3),
      ...move(0.06, WIDE, 0.3, f),
      ...hold(WIDE, 0.3, f),
    ],
    expect: { double: 1 },
  },
  {
    name: 'double clap, one hand lost (merged) at each contact',
    fps: 30,
    frames: (f) => [
      ...hold(WIDE, 0.4, f),
      ...move(WIDE, 0.045, 0.17, f),
      ...oneLost(3, 0.01),
      ...move(0.06, NEAR, 0.1, f),
      ...move(NEAR, 0.05, 0.1, f),
      ...oneLost(3, 0.01),
      ...move(0.06, WIDE, 0.3, f),
    ],
    expect: { double: 1 },
  },
  {
    name: 'double clap with jittery tracking',
    fps: 30,
    frames: (f) => [
      ...hold(WIDE, 0.4, f, 0.004),
      ...move(WIDE, SHUT, 0.2, f, 0.004),
      ...lost(2),
      ...move(0.05, NEAR, 0.13, f, 0.004),
      ...move(NEAR, SHUT, 0.13, f, 0.004),
      ...hold(SHUT, 0.1, f, 0.004),
      ...move(SHUT, WIDE, 0.3, f, 0.004),
    ],
    expect: { double: 1 },
  },
  {
    name: 'double clap at 60 results per second',
    fps: 60,
    frames: (f) => [
      ...hold(WIDE, 0.4, f),
      ...move(WIDE, SHUT, 0.2, f),
      ...hold(SHUT, 0.05, f),
      ...move(SHUT, NEAR, 0.15, f),
      ...move(NEAR, SHUT, 0.15, f),
      ...hold(SHUT, 0.1, f),
      ...move(SHUT, WIDE, 0.3, f),
    ],
    expect: { double: 1 },
  },
  {
    name: 'slow double clap (0.7 s apart)',
    fps: 30,
    frames: (f) => [
      ...hold(WIDE, 0.3, f),
      ...move(WIDE, SHUT, 0.2, f),
      ...hold(SHUT, 0.1, f),
      ...move(SHUT, 0.12, 0.3, f),
      ...move(0.12, SHUT, 0.2, f),
      ...hold(SHUT, 0.2, f),
    ],
    expect: { double: 1 },
  },
  {
    name: 'quick double clap (0.27 s apart), lost at contact',
    fps: 30,
    frames: (f) => [
      ...hold(WIDE, 0.3, f),
      ...move(WIDE, 0.05, 0.17, f),
      ...lost(2),
      ...move(0.06, 0.08, 0.07, f),
      ...move(0.08, 0.05, 0.07, f),
      ...lost(2),
      ...move(0.06, WIDE, 0.3, f),
    ],
    expect: { double: 1 },
  },
  {
    name: 'double clap on a slow machine (15 results per second)',
    fps: 15,
    frames: (f) => [
      ...hold(WIDE, 0.4, f),
      ...move(WIDE, SHUT, 0.27, f),
      ...hold(SHUT, 0.07, f),
      ...move(SHUT, NEAR, 0.2, f),
      ...move(NEAR, SHUT, 0.2, f),
      ...hold(SHUT, 0.2, f),
      ...move(SHUT, WIDE, 0.3, f),
    ],
    expect: { double: 1 },
  },
  {
    name: 'double clap far from the camera (small hands)',
    fps: 30,
    frames: (f) =>
      [
        ...hold(WIDE, 0.4, f),
        ...move(WIDE, SHUT, 0.2, f),
        ...lost(2),
        ...move(0.05, NEAR, 0.13, f),
        ...move(NEAR, SHUT, 0.13, f),
        ...hold(SHUT, 0.1, f),
      ].map((x) => ({
        // Shrink the whole scene toward the middle: the same clap, half the size.
        a: x.a && ([0.5 + (x.a[0] - 0.5) * 0.5, x.a[1]] as [number, number]),
        b: x.b && ([0.5 + (x.b[0] - 0.5) * 0.5, x.b[1]] as [number, number]),
        small: true,
      })),
    expect: { double: 1 },
  },
  {
    name: 'single clap, then hands apart',
    fps: 30,
    frames: (f) => [...hold(WIDE, 0.4, f), ...move(WIDE, SHUT, 0.2, f), ...hold(SHUT, 0.1, f), ...move(SHUT, WIDE, 0.4, f), ...hold(WIDE, 1.2, f)],
    expect: { double: 0, first: 1 },
  },
  {
    name: 'single clap, hands stay together and flicker',
    fps: 30,
    frames: (f) => [
      ...hold(WIDE, 0.4, f),
      ...move(WIDE, 0.04, 0.17, f),
      ...lost(2),
      ...hold(SHUT, 0.07, f, 0.003),
      ...lost(2),
      ...hold(SHUT, 0.07, f, 0.003),
      ...lost(3),
      ...hold(SHUT, 0.5, f, 0.003),
    ],
    expect: { double: 0 },
  },
  {
    name: 'two claps too far apart (1.4 s)',
    fps: 30,
    frames: (f) => [
      ...hold(WIDE, 0.3, f),
      ...move(WIDE, SHUT, 0.2, f),
      ...move(SHUT, WIDE, 0.3, f),
      ...hold(WIDE, 0.9, f),
      ...move(WIDE, SHUT, 0.2, f),
      ...move(SHUT, WIDE, 0.3, f),
      ...hold(WIDE, 1.2, f),
    ],
    expect: { double: 0 },
  },
  {
    name: 'hands drifting together slowly, twice',
    fps: 30,
    frames: (f) => [...hold(WIDE, 0.3, f), ...move(WIDE, SHUT, 1.4, f), ...move(SHUT, NEAR, 0.8, f), ...move(NEAR, SHUT, 0.9, f), ...hold(SHUT, 0.5, f)],
    expect: { double: 0, first: 0 },
  },
  {
    name: 'hands crossing past each other, twice',
    fps: 30,
    frames: (f) => {
      const cross = (from: number, to: number) =>
        Array.from({ length: Math.round(0.33 * f) }, (_, i) => both(from + ((to - from) * (i + 1)) / Math.round(0.33 * f)));
      return [...hold(WIDE, 0.3, f), ...cross(WIDE, -WIDE), ...hold(-WIDE, 0.1, f), ...cross(-WIDE, WIDE), ...hold(WIDE, 0.5, f)];
    },
    expect: { double: 0 },
  },
  {
    name: 'one hand entering the frame beside the other, twice',
    fps: 30,
    frames: (f) => [
      ...oneLost(12, 0.05),
      ...hold(0.05, 0.2, f),
      ...oneLost(8, 0.05),
      ...hold(0.045, 0.2, f),
      ...oneLost(8, 0.05),
      ...hold(0.05, 0.5, f),
    ],
    expect: { double: 0, first: 0 },
  },
  {
    name: 'drawing with the hands close together',
    fps: 30,
    frames: (f) => hold(0.06, 3, f, 0.012),
    expect: { double: 0, first: 0 },
  },
  {
    name: 'both hands brought together to pinch, twice',
    fps: 30,
    frames: (f) => {
      const pinch = (frames: Frame[]) => frames.map((x) => ({ ...x, pinching: true }));
      return [
        ...hold(WIDE, 0.3, f),
        ...move(WIDE, 0.07, 0.3, f),
        ...pinch(hold(0.07, 0.3, f)),
        ...move(0.07, 0.11, 0.2, f),
        ...pinch(move(0.11, 0.06, 0.2, f)),
        ...pinch(hold(0.06, 0.4, f)),
      ];
    },
    expect: { double: 0 },
  },
  {
    name: 'three claps in a row count once',
    fps: 30,
    frames: (f) => [
      ...hold(WIDE, 0.3, f),
      ...move(WIDE, SHUT, 0.2, f),
      ...move(SHUT, NEAR, 0.15, f),
      ...move(NEAR, SHUT, 0.15, f),
      ...move(SHUT, NEAR, 0.15, f),
      ...move(NEAR, SHUT, 0.15, f),
      ...move(SHUT, WIDE, 0.3, f),
      ...hold(WIDE, 0.5, f),
    ],
    expect: { double: 1 },
  },
  {
    name: 'hands fly together, tracking lost, one hand leaves the frame',
    fps: 30,
    frames: (f) => [...hold(WIDE, 0.3, f), ...move(WIDE, 0.05, 0.17, f), ...lost(2), ...oneLost(40, 0.1)],
    expect: { double: 0 },
  },
];

let failed = 0;
for (const c of cases) {
  seed = 7;
  const got = run(c.frames(c.fps), c.fps);
  const ok = got.double === c.expect.double && (c.expect.first === undefined || got.first === c.expect.first);
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${c.name}  ->  first claps ${got.first}, double claps ${got.double}`);
}
console.log(failed ? `\n${failed} of ${cases.length} failed` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);
