// Listening for claps and finger snaps.
//
// Both are sharp, broadband sounds: the level jumps far above the room in a
// few milliseconds and is mostly gone again a twentieth of a second later.
// Speech and music rise more slowly or stay up, and are passed over. What a
// sound that passes actually was (a clap, a snap, a key being hit) is
// decided elsewhere, by looking at the hands.

export interface Onset {
  /** When it started, in seconds, on the clock passed to `push`. */
  time: number;
  /** How far it stood out above the room, in decibels. */
  peak: number;
}

const HOP_SECONDS = 0.0027;
const ROOM_SECONDS = 0.25; // how slowly the idea of "the room" adapts
const OVER_ROOM = 14; // an onset is at least this many times the room's energy
const FLOOR = 1e-5; // and at least this much in absolute terms (about -50 dB)
const ATTACK = 5; // and this many times the loudest moment of the 40 ms before
const PEAK_SECONDS = 0.012; // the peak is looked for this long after the start
const TAIL_FROM = 0.05; // the sound must have died away between these two
const TAIL_TO = 0.07; //   moments after its start
const TAIL_RATIO = 0.2; // to below this fraction of its peak
const REFRACTORY = 0.1;

const toDb = (energy: number) => 10 * Math.log10(Math.max(energy, 1e-12));

/**
 * Finds sharp onsets in a stream of audio samples. It has no ties to the
 * browser, so it can be fed made-up audio in a test.
 */
export class OnsetDetector {
  private readonly hop: number;
  private readonly hopSeconds: number;
  private previous = 0;
  private sum = 0;
  private filled = 0;
  private recent: number[] = [];
  private room = 1e-7;
  private quietUntil = -1;
  private candidate: {
    time: number;
    peak: number;
    /** Energy summed over the first few milliseconds, and how many hops that was. */
    body: number;
    bodyHops: number;
    before: number;
    tail: number;
    tailHops: number;
  } | null = null;
  private held = 1e-12;

  readonly sampleRate: number;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.hop = Math.max(16, Math.round(sampleRate * HOP_SECONDS));
    this.hopSeconds = this.hop / sampleRate;
  }

  /** Recent level in decibels relative to full scale, for a meter. */
  get levelDb(): number {
    return toDb(this.held);
  }

  /** The level a sound has to exceed right now, in the same units. */
  get thresholdDb(): number {
    return toDb(Math.max(this.room * OVER_ROOM, FLOOR));
  }

  /** Takes the next samples; `endTime` is the time of the last one, in seconds. */
  push(samples: Float32Array, endTime: number): Onset[] {
    const found: Onset[] = [];
    const startTime = endTime - samples.length / this.sampleRate;
    for (let i = 0; i < samples.length; i++) {
      // A first difference tilts the balance toward high frequencies, where
      // claps and snaps have most of their energy and voices have little.
      const x = samples[i] - 0.95 * this.previous;
      this.previous = samples[i];
      this.sum += x * x;
      if (++this.filled < this.hop) continue;
      const energy = this.sum / this.hop;
      this.sum = 0;
      this.filled = 0;
      const onset = this.step(energy, startTime + (i + 1) / this.sampleRate);
      if (onset) found.push(onset);
    }
    return found;
  }

  private step(energy: number, time: number): Onset | null {
    let result: Onset | null = null;
    this.held = Math.max(energy, this.held * Math.exp(-this.hopSeconds / 0.12));

    let c = this.candidate;
    // Something far louder than the sound being weighed takes its place: a
    // snap in the middle of a word must not be lost to the word.
    if (c && time - c.time > PEAK_SECONDS && energy > 8 * c.peak && energy > Math.max(this.room * OVER_ROOM, FLOOR)) {
      c = this.candidate = { time, peak: energy, body: 0, bodyHops: 0, before: c.peak, tail: 0, tailHops: 0 };
      this.quietUntil = time + REFRACTORY;
    }
    if (c) {
      const age = time - c.time;
      if (age <= PEAK_SECONDS) {
        c.peak = Math.max(c.peak, energy);
        c.body += energy;
        c.bodyHops++;
      }
      if (age >= TAIL_FROM && age <= TAIL_TO) {
        c.tail += energy;
        c.tailHops++;
      }
      if (age > TAIL_TO) {
        // Short and gone, or back to what was there before it (a snap over
        // talk): an onset. Still going: a voice, a note, a hum.
        // The comparison uses the average over its first few milliseconds
        // rather than one spike, which a voice can also produce.
        const tail = c.tailHops > 0 ? c.tail / c.tailHops : Infinity;
        const body = c.bodyHops > 0 ? c.body / c.bodyHops : c.peak;
        if (tail < Math.max(TAIL_RATIO * body, 1.5 * c.before)) {
          result = { time: c.time, peak: toDb(c.peak) - toDb(this.room) };
        }
        this.candidate = null;
      }
    } else if (time >= this.quietUntil) {
      // Compared with the loudest moment of the last 40 ms, not the last
      // instant: a voice pulses a hundred times a second, and each pulse
      // would otherwise look like an attack.
      const lately = this.recent.length ? Math.max(...this.recent) : this.room;
      if (energy > Math.max(this.room * OVER_ROOM, FLOOR) && energy > ATTACK * Math.max(lately, 1e-9)) {
        this.candidate = { time, peak: energy, body: 0, bodyHops: 0, before: lately, tail: 0, tailHops: 0 };
        this.quietUntil = time + REFRACTORY;
      }
    }

    // The room level follows quiet sound readily and loud sound reluctantly,
    // so a clap barely moves it but steady music raises it within a second.
    const capped = Math.min(energy, this.room * 6);
    this.room = Math.max(1e-9, this.room + (capped - this.room) * (this.hopSeconds / ROOM_SECONDS));
    this.recent.push(energy);
    if (this.recent.length > 16) this.recent.shift();
    return result;
  }
}

/** The microphone, reduced to onsets and a level. */
export class Ear {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private detector: OnsetDetector | null = null;
  private lastContextTime = 0;

  /** True once audio is actually flowing. */
  get listening(): boolean {
    return this.context !== null && this.context.state === 'running';
  }

  /** True if a microphone was granted, even if the browser has not started it yet. */
  get present(): boolean {
    return this.context !== null;
  }

  get levelDb(): number {
    return this.detector ? this.detector.levelDb : -120;
  }

  get thresholdDb(): number {
    return this.detector ? this.detector.thresholdDb : -50;
  }

  /** Starts listening to the audio track of a stream. Returns false if it has none. */
  start(stream: MediaStream): boolean {
    if (stream.getAudioTracks().length === 0) return false;
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return false;
    const context = new Context({ latencyHint: 'interactive' });
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    // Only listened to, never played back.
    context.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(analyser);
    this.context = context;
    this.analyser = analyser;
    this.buffer = new Float32Array(analyser.fftSize);
    this.detector = new OnsetDetector(context.sampleRate);
    this.lastContextTime = context.currentTime;
    // Some browsers hold audio back until the page has been interacted with.
    const wake = () => void context.resume();
    wake();
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return true;
  }

  /** Onsets heard since the last call. `now` is the current time in seconds on the caller's clock. */
  poll(now: number): Onset[] {
    if (!this.context || !this.analyser || !this.buffer || !this.detector || !this.listening) return [];
    const elapsed = this.context.currentTime - this.lastContextTime;
    this.lastContextTime = this.context.currentTime;
    const fresh = Math.min(this.buffer.length, Math.round(elapsed * this.context.sampleRate));
    if (fresh <= 0) return [];
    this.analyser.getFloatTimeDomainData(this.buffer);
    return this.detector.push(this.buffer.subarray(this.buffer.length - fresh), now);
  }
}
