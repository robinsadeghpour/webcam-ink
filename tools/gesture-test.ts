// Checks how sounds and hands are put together: a sharp sound only counts as
// a snap or a clap if the hands were doing something that explains it.
//
//     node tools/gesture-test.ts

import { GestureReader } from '../src/gestures.ts';

const ASPECT = 16 / 9;
const FPS = 30;
const SIZE = 0.19;

interface Hand {
  slot: 0 | 1;
  x: number;
  y?: number;
  /** Thumb pressed to the middle finger. */
  ready?: boolean;
  /** Thumb-to-middle distance in hand sizes. */
  snapGap?: number;
  /** How straight the middle finger is; a finger that has snapped is folded (about 0.3). */
  straight?: number;
  pinched?: boolean;
  pinching?: boolean;
}

interface Frame {
  hands: Hand[];
  /** A sharp sound landing during this frame. */
  sound?: boolean;
}

function state(h: Hand): any {
  const at = { x: h.x, y: h.y ?? 0.5 };
  return {
    slot: h.slot,
    palm: at,
    size: SIZE,
    pinching: !!h.pinching,
    pinched: !!h.pinched,
    pinchPoint: at,
    snapPoint: at,
    snapGap: h.snapGap ?? (h.ready ? 0.1 : 0.9),
    snapReady: !!h.ready,
    middleStraight: h.straight ?? (h.ready ? 0.6 : (h.snapGap ?? 0.9) > 0.4 && h.snapGap !== undefined ? 0.3 : 0.9),
    gesture: 'rest',
  };
}

interface Tally {
  snaps: number;
  first: number;
  double: number;
  unplaced: number;
  drops: number;
}

function run(frames: Frame[], mic = true): Tally {
  const reader = new GestureReader();
  const tally: Tally = { snaps: 0, first: 0, double: 0, unplaced: 0, drops: 0 };
  frames.forEach((frame, i) => {
    const time = 10 + i / FPS;
    const sounds = frame.sound ? [{ time: time - 0.01, peak: 30 }] : [];
    const events = reader.update(frame.hands.map(state), time, ASPECT, mic ? sounds : null);
    if (events.snap) tally.snaps++;
    if (events.clap?.count === 1) tally.first++;
    if (events.clap?.count === 2) tally.double++;
    if (events.unplaced) tally.unplaced++;
    tally.drops += events.drops.length;
  });
  return tally;
}

const repeat = (n: number, make: (i: number) => Frame): Frame[] => Array.from({ length: n }, (_, i) => make(i));
const idle = (n: number): Frame[] => repeat(n, () => ({ hands: [] }));
const one = (n: number, hand: Partial<Hand> = {}): Frame[] => repeat(n, () => ({ hands: [{ slot: 0, x: 0.4, ...hand }] }));
const two = (n: number, half: number): Frame[] =>
  repeat(n, () => ({ hands: [{ slot: 0, x: 0.5 - half }, { slot: 1, x: 0.5 + half }] }));
const withSound = (frames: Frame[], at = 0): Frame[] => frames.map((f, i) => (i === at ? { ...f, sound: true } : f));

interface Case {
  name: string;
  frames: Frame[];
  mic?: boolean;
  expect: Partial<Tally>;
}

const cases: Case[] = [
  {
    name: 'snap: thumb on middle finger, a sound, the finger flies off',
    frames: [...one(10), ...one(8, { ready: true }), ...withSound(one(10, { snapGap: 0.7 }))],
    expect: { snaps: 1, unplaced: 0 },
  },
  {
    name: 'snap where the picture lags the sound by two frames',
    frames: [...one(10), ...one(6, { ready: true }), ...withSound(one(2, { ready: true })), ...one(10, { snapGap: 0.7 })],
    expect: { snaps: 1 },
  },
  {
    name: 'snap where the hand blurs out of tracking as the finger moves',
    frames: [...one(10), ...one(8, { ready: true }), ...withSound(idle(4)), ...one(10, { snapGap: 0.8 })],
    expect: { snaps: 1 },
  },
  {
    name: 'a sound while a hand just rests thumb on middle finger (pointing): no snap',
    frames: [...one(20, { ready: true }), ...withSound(one(20, { ready: true }))],
    expect: { snaps: 0, unplaced: 1 },
  },
  {
    name: 'thumb leaves the middle finger because the hand opens, with a sound: no snap',
    frames: [...one(10), ...one(8, { ready: true }), ...withSound(one(10, { snapGap: 0.9, straight: 0.95 }))],
    expect: { snaps: 0, unplaced: 1 },
  },
  {
    name: 'thumb was on the middle finger half a second before the sound, not at it: no snap',
    frames: [...one(8, { ready: true }), ...one(15), ...withSound(one(10, { snapGap: 0.7 }))],
    expect: { snaps: 0, unplaced: 1 },
  },
  {
    name: 'a sound with no hands in view',
    frames: [...idle(10), ...withSound(idle(15))],
    expect: { snaps: 0, first: 0, unplaced: 1 },
  },
  {
    name: 'a sound with one idle hand in view',
    frames: [...one(10), ...withSound(one(15))],
    expect: { snaps: 0, first: 0, unplaced: 1 },
  },
  {
    name: 'talk and typing while drawing: five sounds, none placed',
    frames: repeat(90, (i) => ({ hands: [{ slot: 0, x: 0.3 + i * 0.003 }], sound: i % 17 === 5 })),
    expect: { snaps: 0, first: 0, double: 0, unplaced: 5 },
  },
  {
    name: 'the finger flicks but there is no sound: nothing',
    frames: [...one(10), ...one(8, { ready: true }), ...one(10, { snapGap: 0.7 })],
    expect: { snaps: 0 },
  },
  {
    name: 'two snaps half a second apart count twice',
    frames: [
      ...one(8, { ready: true }),
      ...withSound(one(8, { snapGap: 0.7 })),
      ...one(8, { ready: true }),
      ...withSound(one(8, { snapGap: 0.7 })),
      ...one(20),
    ],
    expect: { snaps: 2 },
  },
  {
    name: 'a pinch drop right after a snap is held back',
    frames: [
      ...one(8, { ready: true }),
      ...withSound(one(3, { snapGap: 0.7 })),
      ...one(1, { pinched: true, pinching: true }),
      ...one(6, { pinching: true }),
    ],
    expect: { snaps: 1, drops: 0 },
  },
  {
    name: 'heard clap: hands together and a sound',
    frames: [...two(10, 0.16), ...two(3, 0.1), ...withSound(two(6, 0.03)), ...two(30, 0.16)],
    expect: { first: 1, double: 0 },
  },
  {
    name: 'heard double clap',
    frames: [...two(10, 0.16), ...withSound(two(5, 0.03)), ...two(5, 0.09), ...withSound(two(5, 0.03)), ...two(20, 0.16)],
    expect: { first: 1, double: 1 },
  },
  {
    name: 'heard double clap with the hands lost at each contact',
    frames: [...two(10, 0.16), ...two(2, 0.08), ...withSound(idle(3)), ...two(4, 0.09), ...withSound(idle(3)), ...two(20, 0.16)],
    expect: { first: 1, double: 1 },
  },
  {
    name: 'hands clap silently while a microphone is listening: nothing',
    frames: [...two(10, 0.16), ...two(4, 0.03), ...two(5, 0.09), ...two(4, 0.03), ...two(20, 0.16)],
    expect: { first: 0, double: 0 },
  },
  {
    name: 'a sound with the hands far apart and still',
    frames: [...two(15, 0.2), ...withSound(two(15, 0.2))],
    expect: { first: 0, double: 0, unplaced: 1 },
  },
  {
    name: 'two sounds 1.5 s apart with hands together: two firsts, no double',
    frames: [...withSound(two(45, 0.03)), ...withSound(two(20, 0.03))],
    expect: { first: 2, double: 0 },
  },
  {
    name: 'without a microphone a snap is not available',
    frames: [...one(10), ...one(8, { ready: true }), ...one(10, { snapGap: 0.7 })],
    mic: false,
    expect: { snaps: 0 },
  },
];

let failed = 0;
for (const c of cases) {
  const got = run(c.frames, c.mic ?? true);
  const ok = (Object.keys(c.expect) as (keyof Tally)[]).every((k) => got[k] === c.expect[k]);
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${c.name}  ->  ${JSON.stringify(got)}`);
}
console.log(failed ? `\n${failed} of ${cases.length} failed` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);
