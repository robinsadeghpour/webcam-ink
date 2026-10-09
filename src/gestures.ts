// Events that happen over time across one or both hands: a pinch that is
// held and released, two pinches at once, a finger snap and a double clap.
//
// Snaps and claps are heard, not seen: the microphone says when, and the
// hands say whether and where. Without a microphone, claps fall back to
// being read from the hands alone and snaps are not available.

import type { Onset } from './audio';
import type { HandState, Point } from './hands';

export interface Drop extends Point {
  slot: 0 | 1;
  /** 1 for a quick pinch; up to 2.6 for a fully charged release. */
  power: number;
}

export interface GestureEvents {
  drops: Drop[];
  /** Both hands pinched at the same moment: where, halfway between them. */
  twin: Point | null;
  /**
   * A clap was recognised: where, and whether it is the first or the second
   * of a pair. `peak` is how loud it was, when it was heard rather than seen.
   */
  clap: (Point & { count: 1 | 2; peak?: number }) | null;
  /** A finger snap: where, by which hand, and how loud. */
  snap: (Point & { slot: 0 | 1; peak: number }) | null;
  /** A sharp sound that no hand accounts for: speech, a key, a door. */
  unplaced: { peak: number } | null;
  /**
   * True while the hands are rushing together or between the two claps of a
   * pair. Nothing else should react to the hands during that time.
   */
  busy: boolean;
}

interface PinchState {
  since: number; // when the pinch closed, or -1
  point: Point;
  charge: number;
}

const CHARGE_DELAY = 0.35; // seconds a pinch must be held before it starts to charge
const CHARGE_SECONDS = 1.4; // seconds from there to a full charge
const TWIN_WINDOW = 0.3; // seconds between two pinches that still count as one
const SOUND_PATIENCE = 0.25; // seconds a sound waits for the camera to explain it
const SNAP_COOLDOWN = 0.5;

// --- Clap ------------------------------------------------------------------------
// Distances are in hand sizes (wrist to middle knuckle), so the numbers hold
// whether the hands are near the camera or far from it.

/** Seconds after the first clap in which the second must land. */
export const CLAP_WINDOW = 0.9;
const CLAP_MIN_INTERVAL = 0.16; // closer together than this is one clap seen twice
const CLAP_COOLDOWN = 1.5; // after a double clap
const CONTACT = 1.4; // palms this close have met
const APART = 1.4; // and must get this far apart again before the next clap
const HISTORY = 0.4; // seconds of samples kept
// What counts as rushing together: peak closing speed (hand sizes per
// second) and how much ground was covered. The second clap of a pair is a
// shorter, gentler movement, so it gets easier limits.
const FIRST = { speed: 6, covered: 1.0, straight: 1.4 };
const SECOND = { speed: 3.5, covered: 0.25, straight: 1.0 };

interface Sample {
  t: number;
  // Vector from one palm to the other, and their midpoint, with x scaled so
  // that both axes are in stage heights.
  dx: number;
  dy: number;
  gap: number;
  unit: number;
  mid: Point;
}

interface Approach {
  speed: number;
  covered: number;
  along: number;
  across: number;
  /** Seconds until the palms would meet at the current rate. */
  eta: number;
}

/**
 * Recognises claps from the two palm positions.
 *
 * Trackers lose or merge hands at the moment they touch, so the hands do not
 * have to be seen in contact. What is required is a fast, head-on approach,
 * followed either by the palms being seen together or by tracking dropping
 * out just as they were about to meet. A clap is then confirmed a moment
 * later, once it is clear the hands stopped rather than passed each other.
 */
export class ClapReader {
  private samples: Sample[] = [];
  private missing = 0;
  private lastSeen = -10;
  private approach: Approach | null = null;
  private contact: { t: number; mid: Point; nx: number; ny: number; speed: number } | null = null;
  private count = 0;
  private first = -10;
  private firstAt: Point = { x: 0.5, y: 0.5 };
  private separated = true;
  private lastDouble = -10;
  private rushing = false;

  /** While waiting for the second clap: how much of the window is left, 1..0. Otherwise 0. */
  windowLeft(time: number): number {
    return this.count === 1 ? Math.max(0, 1 - (time - this.first) / CLAP_WINDOW) : 0;
  }

  get busy(): boolean {
    return this.rushing || this.contact !== null || this.count === 1;
  }

  /**
   * Call once per tracking result. With `byEar`, claps are announced by the
   * microphone (see `heard`) and this only keeps track of where the hands
   * are; without it, claps are recognised from the hands alone.
   */
  update(
    a: HandState | undefined,
    b: HandState | undefined,
    time: number,
    stageAspect: number,
    byEar = false,
  ): (Point & { count: 1 | 2 }) | null {
    // The window for a second clap has passed: forget the first.
    if (this.count === 1 && time - this.first > CLAP_WINDOW && !this.contact) this.count = 0;

    if (!a || !b) {
      if (!byEar) return this.withoutBoth(time);
      this.missing++;
      this.rushing = false;
      if (time - this.lastSeen > HISTORY) {
        this.samples = [];
        this.approach = null;
      }
      return null;
    }

    const dx = (b.palm.x - a.palm.x) * stageAspect;
    const dy = b.palm.y - a.palm.y;
    const sample: Sample = {
      t: time,
      dx,
      dy,
      gap: Math.hypot(dx, dy),
      unit: Math.max((a.size + b.size) / 2, 1e-4),
      mid: { x: (a.palm.x + b.palm.x) / 2, y: (a.palm.y + b.palm.y) / 2 },
    };
    const reappeared = this.missing >= 2;
    this.missing = 0;
    this.lastSeen = time;
    this.samples = this.samples.filter((s) => time - s.t < HISTORY);
    this.samples.push(sample);
    const r = sample.gap / sample.unit;
    if (r > APART) this.separated = true;
    this.approach = this.measure();
    const pinching = a.pinching || b.pinching;
    const previous = this.samples.length > 1 ? this.samples[this.samples.length - 2] : null;
    const nowSpeed = previous ? (previous.gap - sample.gap) / Math.max(time - previous.t, 1e-3) / sample.unit : 0;
    this.rushing = !pinching && nowSpeed > 4 && this.approach !== null && this.approach.along > this.approach.across;
    if (byEar) {
      this.contact = null;
      return null;
    }

    if (this.contact) {
      // Did they pass each other? Then the palms are now on swapped sides.
      const side = dx * this.contact.nx + dy * this.contact.ny;
      if (side < 0 && r > 0.5) {
        this.contact = null;
        this.samples = [sample];
        return null;
      }
      const stopped = Math.abs(nowSpeed) < 0.4 * this.contact.speed;
      if (stopped || (nowSpeed < 0 && side > 0) || reappeared || time - this.contact.t > 0.2) return this.confirm(time);
      return null;
    }

    const limits = this.count === 0 ? FIRST : SECOND;
    if (
      r < CONTACT &&
      !pinching &&
      this.separated &&
      time - this.lastDouble > CLAP_COOLDOWN &&
      this.approach !== null &&
      this.fast(this.approach, limits)
    ) {
      this.touch(time, sample.mid, this.approach.speed);
    }
    return null;
  }

  /**
   * Could a sharp sound at `soundTime` have been these hands clapping? Yes
   * if, in the third of a second before it or since, both hands were seen
   * close together, or closing on each other. Returns where, or null.
   */
  near(soundTime: number): Point | null {
    const recent = this.samples.filter((s) => s.t > soundTime - 0.35);
    for (const s of recent) if (s.gap / s.unit < 2.4) return s.mid;
    const last = recent[recent.length - 1];
    const closing = this.approach !== null && this.approach.speed > 2 && this.approach.covered > 0.3;
    return last && closing && last.gap / last.unit < 4 ? last.mid : null;
  }

  /** A clap was heard and the hands agree. Counts it as the first or second of a pair. */
  heard(time: number, at: Point): (Point & { count: 1 | 2 }) | null {
    if (time - this.lastDouble < CLAP_COOLDOWN) return null;
    if (this.count === 0 || time - this.first > CLAP_WINDOW) {
      this.count = 1;
      this.first = time;
      this.firstAt = at;
      return { ...at, count: 1 };
    }
    if (time - this.first < CLAP_MIN_INTERVAL) return null;
    this.count = 0;
    this.lastDouble = time;
    return { x: (at.x + this.firstAt.x) / 2, y: (at.y + this.firstAt.y) / 2, count: 2 };
  }

  private withoutBoth(time: number): (Point & { count: 1 | 2 }) | null {
    this.missing++;
    this.rushing = false;
    if (this.contact) {
      // Seen together, or about to be, and now tracking has gone: they met.
      if (this.missing >= 2 || time - this.contact.t > 0.12) return this.confirm(time);
      return null;
    }
    // Tracking dropped out. If the hands were rushing together and about to
    // meet, treat this as the moment of contact and wait one more result.
    const last = this.samples[this.samples.length - 1];
    const limits = this.count === 0 ? FIRST : SECOND;
    if (
      this.missing === 1 &&
      last &&
      time - this.lastSeen < 0.12 &&
      this.separated &&
      time - this.lastDouble > CLAP_COOLDOWN &&
      this.approach !== null &&
      this.fast(this.approach, limits) &&
      this.approach.eta < 0.15 &&
      last.gap / last.unit < 3.2
    ) {
      this.touch(time, last.mid, this.approach.speed);
    }
    if (time - this.lastSeen > HISTORY) {
      this.samples = [];
      this.approach = null;
    }
    return null;
  }

  private fast(approach: Approach, limits: typeof FIRST): boolean {
    return (
      approach.speed >= limits.speed &&
      approach.covered >= limits.covered &&
      approach.along > limits.straight * approach.across
    );
  }

  /** How the palms have been closing over the last few samples. */
  private measure(): Approach | null {
    const s = this.samples;
    if (s.length < 2) return null;
    const now = s[s.length - 1];
    let speed = 0;
    for (let i = 1; i < s.length; i++) {
      const dt = s[i].t - s[i - 1].t;
      if (dt > 0 && dt < 0.12) speed = Math.max(speed, (s[i - 1].gap - s[i].gap) / dt / now.unit);
    }
    // Measure from the moment they were farthest apart.
    let start = s[0];
    for (const sample of s) if (sample.gap > start.gap) start = sample;
    if (start === now || start.gap < 1e-6) return null;
    const nx = start.dx / start.gap;
    const ny = start.dy / start.gap;
    const mx = now.dx - start.dx;
    const my = now.dy - start.dy;
    const along = -(mx * nx + my * ny) / now.unit;
    const across = Math.abs(mx * ny - my * nx) / now.unit;
    const last = s[s.length - 2];
    const rate = (last.gap - now.gap) / Math.max(now.t - last.t, 1e-3);
    const eta = rate > 0 ? Math.max(0, now.gap - 1.0 * now.unit) / rate : Infinity;
    return { speed, covered: (start.gap - now.gap) / now.unit, along, across, eta };
  }

  private touch(time: number, mid: Point, speed: number): void {
    // The axis the hands came in along, from the earliest sample still held.
    const start = this.samples.reduce((far, s) => (s.gap > far.gap ? s : far), this.samples[0]);
    const gap = start && start.gap > 1e-6 ? start.gap : 1;
    this.contact = { t: time, mid, nx: start ? start.dx / gap : 1, ny: start ? start.dy / gap : 0, speed };
  }

  private confirm(time: number): (Point & { count: 1 | 2 }) | null {
    const at = this.contact!.mid;
    this.contact = null;
    this.samples = [];
    this.approach = null;
    this.separated = false;
    this.rushing = false;
    if (this.count === 0) {
      this.count = 1;
      this.first = time;
      this.firstAt = at;
      return { ...at, count: 1 };
    }
    if (time - this.first < CLAP_MIN_INTERVAL) return null;
    this.count = 0;
    this.lastDouble = time;
    // Report the pair where it started, so the two marks do not jump apart.
    return { x: (at.x + this.firstAt.x) / 2, y: (at.y + this.firstAt.y) / 2, count: 2 };
  }
}

/** One look at a hand's thumb and middle finger. */
interface SnapSample {
  t: number;
  gap: number;
  ready: boolean;
  /** How straight the middle finger is. */
  straight: number;
  at: Point;
}

export class GestureReader {
  private readonly pinch: PinchState[] = [0, 1].map(() => ({ since: -1, point: { x: 0, y: 0 }, charge: 0 }));
  private readonly claps = new ClapReader();
  // Recent looks at each hand's thumb and middle finger, and how many
  // results in a row each hand has been out of sight.
  private readonly fingers: SnapSample[][] = [[], []];
  private readonly absent = [0, 0];
  // Sounds still waiting for the camera to say what they were.
  private waiting: Onset[] = [];
  private lastTwin = -10;
  private lastSnap = -10;
  private quietUntil = -10;
  private readonly snapQuiet = [-10, -10];

  /** A hand's held pinch: where it is and how charged, 0..1. Null if not pinching. */
  held(slot: number): { x: number; y: number; charge: number } | null {
    const state = this.pinch[slot];
    return state.since >= 0 ? { ...state.point, charge: state.charge } : null;
  }

  /** While waiting for a second clap: how much of the window is left, 1..0. */
  clapWindow(time: number): number {
    return this.claps.windowLeft(time);
  }

  /**
   * Call once per tracking result. `time` is in seconds. `sounds` are the
   * sharp sounds heard since the last call, on the same clock; pass null when
   * there is no microphone, and claps are then read from the hands alone.
   */
  update(hands: HandState[], time: number, stageAspect: number, sounds: Onset[] | null = null): GestureEvents {
    const events: GestureEvents = { drops: [], twin: null, clap: null, snap: null, unplaced: null, busy: false };
    const bySlot: (HandState | undefined)[] = [undefined, undefined];
    for (const hand of hands) bySlot[hand.slot] = hand;
    const byEar = sounds !== null;

    events.clap = this.claps.update(bySlot[0], bySlot[1], time, stageAspect, byEar);

    for (const slot of [0, 1] as const) {
      const hand = bySlot[slot];
      this.fingers[slot] = this.fingers[slot].filter((m) => time - m.t < 0.8);
      this.absent[slot] = hand ? 0 : this.absent[slot] + 1;
      if (hand) {
        this.fingers[slot].push({
          t: time,
          gap: hand.snapGap,
          ready: hand.snapReady,
          straight: hand.middleStraight,
          at: hand.snapPoint,
        });
      }
    }

    if (sounds) {
      this.waiting.push(...sounds);
      const still: Onset[] = [];
      for (const sound of this.waiting) {
        // The picture runs a little behind the sound, so a sound gets a few
        // more results before it is given up on.
        const placed = this.place(sound, time, events, time - sound.time >= SOUND_PATIENCE);
        if (placed === 'wait') still.push(sound);
        else if (placed === 'no') events.unplaced = { peak: sound.peak };
      }
      this.waiting = still;
    }

    // Hands that are clapping are not drawing, pinching or measuring; that
    // holds for a moment after the second clap as well.
    if (events.clap?.count === 2) this.quietUntil = time + 0.35;
    events.busy = this.claps.busy || time < this.quietUntil;

    for (const slot of [0, 1] as const) {
      const hand = bySlot[slot];
      const state = this.pinch[slot];
      if (!hand || events.busy || time < this.snapQuiet[slot]) {
        // A hand that leaves, claps or snaps mid-pinch lets nothing go.
        state.since = -1;
        state.charge = 0;
        continue;
      }
      if (hand.pinched) {
        state.since = time;
        state.charge = 0;
        events.drops.push({ ...hand.pinchPoint, slot, power: 1 });
        const other = this.pinch[1 - slot];
        if (other.since >= 0 && time - other.since < TWIN_WINDOW && time - this.lastTwin > 1) {
          this.lastTwin = time;
          events.twin = {
            x: (hand.pinchPoint.x + other.point.x) / 2,
            y: (hand.pinchPoint.y + other.point.y) / 2,
          };
        }
      }
      if (hand.pinching && state.since >= 0) {
        state.point = hand.pinchPoint;
        state.charge = Math.min(1, Math.max(0, (time - state.since - CHARGE_DELAY) / CHARGE_SECONDS));
      } else if (state.since >= 0) {
        // Released: a held pinch lets go of what it gathered.
        if (state.charge > 0.08) events.drops.push({ ...state.point, slot, power: 1 + 1.6 * state.charge });
        state.since = -1;
        state.charge = 0;
      }
    }
    return events;
  }

  /**
   * Decides what a sharp sound was by what the hands were doing. Answers
   * 'yes' once it has been accounted for, 'wait' if the next results might
   * still explain it, and 'no' if nothing does.
   */
  private place(sound: Onset, time: number, events: GestureEvents, last: boolean): 'yes' | 'wait' | 'no' {
    // A clap: both hands were together, or closing on each other.
    const where = this.claps.near(sound.time);
    if (where) {
      const clap = this.claps.heard(sound.time, where);
      if (clap) events.clap = { ...clap, peak: sound.peak };
      return 'yes';
    }

    // A snap: a hand had its thumb pressed to its middle finger right up to
    // the sound, and straight after it the finger has left the thumb and
    // folded into the palm. Timing and direction both matter: a pointing
    // hand rests thumb on middle finger but nothing moves, and a hand that
    // simply opens moves the finger the other way.
    if (time - this.lastSnap > SNAP_COOLDOWN) {
      for (const slot of [0, 1] as const) {
        const looks = this.fingers[slot];
        const ready = [...looks].reverse().find((m) => m.ready && m.t > sound.time - 0.18 && m.t < sound.time + 0.06);
        if (!ready) continue;
        const flicked = looks.some(
          (m) => m.t > ready.t && m.t < sound.time + 0.22 && m.gap > ready.gap + 0.2 && m.straight < 0.5,
        );
        // A finger moving that fast often blurs the hand out of tracking.
        const blurred = this.absent[slot] >= 2 && time > sound.time && looks[looks.length - 1] === ready;
        if (!flicked && !blurred) continue;
        this.lastSnap = time;
        this.snapQuiet[slot] = time + 0.4;
        events.snap = { ...ready.at, slot, peak: sound.peak };
        return 'yes';
      }
    }
    return last ? 'no' : 'wait';
  }
}
