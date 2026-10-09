// Feeds made-up audio to the onset detector and checks what it hears.
//
//     node tools/audio-test.ts

import { OnsetDetector } from '../src/audio.ts';

const RATE = 48000;

let seed = 11;
function rand(): number {
  seed = (seed * 16807) % 2147483647;
  return (seed / 2147483647) * 2 - 1;
}

/** A buffer of faint room noise. */
function room(seconds: number, level = 0.002): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = rand() * level;
  return out;
}

/** Adds a burst of noise that decays quickly: a clap or a snap. */
function burst(into: Float32Array, at: number, peak: number, decaySeconds: number): void {
  const start = Math.round(at * RATE);
  for (let i = 0; start + i < into.length && i < RATE * 0.4; i++) {
    into[start + i] += rand() * peak * Math.exp(-i / (decaySeconds * RATE));
  }
}

/** Adds a steady tone with a sudden start. */
function tone(into: Float32Array, at: number, seconds: number, hz: number, level: number): void {
  const start = Math.round(at * RATE);
  for (let i = 0; i < seconds * RATE && start + i < into.length; i++) {
    into[start + i] += Math.sin((2 * Math.PI * hz * i) / RATE) * level;
  }
}

/** Adds something like speech: low-passed noise that swells and fades in syllables. */
function speech(into: Float32Array, at: number, seconds: number, level: number): void {
  const start = Math.round(at * RATE);
  let low = 0;
  for (let i = 0; i < seconds * RATE && start + i < into.length; i++) {
    low += (rand() - low) * 0.06;
    const t = i / RATE;
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 3.5 * t)) ** 1.5;
    const pitch = 0.6 + 0.4 * Math.sin(2 * Math.PI * 140 * t);
    into[start + i] += low * 6 * level * syllable * pitch;
  }
}

function hear(audio: Float32Array, block = 800): number[] {
  const detector = new OnsetDetector(RATE);
  const times: number[] = [];
  for (let i = 0; i < audio.length; i += block) {
    const chunk = audio.subarray(i, Math.min(audio.length, i + block));
    for (const onset of detector.push(chunk, (i + chunk.length) / RATE)) times.push(onset.time);
  }
  return times;
}

interface Case {
  name: string;
  audio: () => Float32Array;
  /** Times at which an onset should be heard, within 30 ms; nothing else may be heard. */
  expect: number[];
  /**
   * Allow this many extra onsets. Talk does now and then produce one; that
   * is what the camera check is for.
   */
  extra?: number;
}

const cases: Case[] = [
  { name: 'a quiet room', audio: () => room(3), expect: [] },
  {
    name: 'one clap',
    audio: () => {
      const a = room(2);
      burst(a, 1.0, 0.6, 0.012);
      return a;
    },
    expect: [1.0],
  },
  {
    name: 'two claps 0.4 s apart',
    audio: () => {
      const a = room(2.5);
      burst(a, 1.0, 0.6, 0.012);
      burst(a, 1.4, 0.5, 0.012);
      return a;
    },
    expect: [1.0, 1.4],
  },
  {
    name: 'a soft finger snap',
    audio: () => {
      const a = room(2);
      burst(a, 0.8, 0.08, 0.006);
      return a;
    },
    expect: [0.8],
  },
  {
    name: 'a clap in a reverberant room',
    audio: () => {
      const a = room(2);
      burst(a, 1.0, 0.6, 0.02);
      return a;
    },
    expect: [1.0],
  },
  {
    name: 'a clap over steady background noise',
    audio: () => {
      const a = room(3, 0.02);
      burst(a, 2.0, 0.7, 0.012);
      return a;
    },
    expect: [2.0],
  },
  {
    name: 'a tone that starts suddenly and stays',
    audio: () => {
      const a = room(3);
      tone(a, 1.0, 1.5, 440, 0.4);
      return a;
    },
    expect: [],
  },
  {
    name: 'a high beep, 0.3 s long',
    audio: () => {
      const a = room(2);
      tone(a, 0.8, 0.3, 3000, 0.3);
      return a;
    },
    expect: [],
  },
  {
    name: 'speech-like sound for two seconds',
    audio: () => {
      const a = room(3);
      speech(a, 0.5, 2, 0.5);
      return a;
    },
    expect: [],
  },
  {
    name: 'a snap in the middle of speech',
    audio: () => {
      const a = room(3);
      speech(a, 0.3, 2.4, 0.25);
      burst(a, 1.5, 0.5, 0.006);
      return a;
    },
    expect: [1.5],
    extra: 1,
  },
  {
    name: 'music-like: loud steady noise with a slow beat',
    audio: () => {
      const a = room(4);
      for (let i = 0; i < a.length; i++) a[i] += rand() * 0.15 * (0.7 + 0.3 * Math.sin((2 * Math.PI * 2 * i) / RATE));
      return a;
    },
    expect: [],
  },
  {
    name: 'a key click (short and sharp: heard, and left to the camera to reject)',
    audio: () => {
      const a = room(2);
      burst(a, 1.2, 0.12, 0.003);
      return a;
    },
    expect: [1.2],
  },
  {
    name: 'fed in tiny blocks, as a slow frame would',
    audio: () => {
      const a = room(2);
      burst(a, 1.0, 0.6, 0.012);
      return a;
    },
    expect: [1.0],
  },
];

let failed = 0;
for (const c of cases) {
  seed = 11;
  const heard = hear(c.audio(), c.name.includes('tiny blocks') ? 128 : 800);
  const wanted = c.expect.every((t) => heard.some((h) => Math.abs(h - t) < 0.03));
  const ok = wanted && heard.length <= c.expect.length + (c.extra ?? 0);
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${c.name}  ->  heard at [${heard.map((t) => t.toFixed(2)).join(', ')}]`);
}
console.log(failed ? `\n${failed} of ${cases.length} failed` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);
