// Turns moving points (fingertips, a mouse, the demo) into ink and motion.
//
// Positions come in as stage coordinates: x and y in [0,1], y pointing down.
// Each point is smoothed twice: an adaptive low-pass on the raw samples to
// take out tracking jitter, then a short follow at display rate so strokes
// stay continuous between samples.

import { Fluid } from './fluid';

export type TipKind = 'ink' | 'stir';

interface Tip {
  kind: TipKind;
  pigment: 0 | 1;
  // adaptive low-pass state
  fx: number;
  fy: number;
  dx: number;
  dy: number;
  sampleTime: number;
  /** Brush clock when the last sample arrived. */
  heard: number;
  // where the pen is now
  px: number;
  py: number;
  // 0..1, eases in and out so strokes start and end softly
  flow: number;
  flowTarget: number;
  lifted: boolean;
  /** 0..1: how much this point is putting into the water right now. */
  level: number;
  /** Velocity of the pen in stage heights per second, y pointing down. */
  vx: number;
  vy: number;
  /** Fixed per point; keeps the grain of its stroke continuous. */
  grainPhase: number;
}

export interface BrushSettings {
  inkRadius: number;
  /** Pigment laid down along a moving stroke. */
  lineDensity: number;
  /** Pigment per second that seeps from a resting tip. */
  seep: number;
  pushRadius: number;
  /** Fraction of the tip's velocity left behind in the water it passes through. */
  push: number;
}

export const DEFAULT_BRUSH: BrushSettings = {
  inkRadius: 0.0048,
  lineDensity: 1.5,
  seep: 1.6,
  pushRadius: 0.022,
  push: 0.42,
};

const TAU = Math.PI * 2;
const QUIET_SECONDS = 0.3;

function smoothing(cutoffHz: number, dt: number): number {
  const rc = 1 / (TAU * cutoffHz);
  return dt / (dt + rc);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface Motion {
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  level: number;
  pigment: 0 | 1;
}

export class Brush {
  readonly settings: BrushSettings = { ...DEFAULT_BRUSH };
  /** Scales every mark; a wide stage needs heavier marks than a tall one. */
  scale = 1;
  /** Extra stroke width per pigment, set from how far apart the hands are. */
  widthGain = 1;
  /** Called whenever a drop lands, with its stage position and power. */
  onDrop: (x: number, y: number, power: number) => void = () => {};
  private readonly tips = new Map<string, Tip>();
  private clock = 0;

  constructor(public fluid: Fluid) {}

  /** Feeds a new sample for a point. `time` is in seconds. */
  point(id: string, x: number, y: number, time: number, kind: TipKind, pigment: 0 | 1, flow = 1): void {
    let tip = this.tips.get(id);
    const jumped = tip ? Math.hypot(x - tip.fx, y - tip.fy) > 0.3 : false;
    if (!tip || jumped || tip.lifted) {
      const keepFlow = tip && !jumped ? tip.flow : 0;
      const carry = tip && !jumped;
      tip = {
        kind,
        pigment,
        fx: x,
        fy: y,
        dx: 0,
        dy: 0,
        sampleTime: time,
        heard: this.clock,
        px: carry ? tip!.px : x,
        py: carry ? tip!.py : y,
        flow: keepFlow,
        flowTarget: flow,
        lifted: false,
        level: 0,
        vx: 0,
        vy: 0,
        grainPhase: tip ? tip.grainPhase : Math.random() * 40,
      };
      this.tips.set(id, tip);
      return;
    }

    const dt = Math.max(1e-3, time - tip.sampleTime);
    tip.sampleTime = time;
    tip.heard = this.clock;
    // Low-pass the speed, then let the speed set how hard position is
    // smoothed: slow = steady hand, fast = no lag.
    const a = smoothing(1.2, dt);
    tip.dx += ((x - tip.fx) / dt - tip.dx) * a;
    tip.dy += ((y - tip.fy) / dt - tip.dy) * a;
    const speed = Math.hypot(tip.dx * this.fluid.aspect, tip.dy);
    const k = smoothing(1.6 + 9 * speed, dt);
    tip.fx += (x - tip.fx) * k;
    tip.fy += (y - tip.fy) * k;
    tip.kind = kind;
    tip.pigment = pigment;
    tip.flowTarget = flow;
  }

  /** Stops a point; its stroke tapers off instead of ending abruptly. */
  lift(id: string): void {
    const tip = this.tips.get(id);
    if (tip) {
      tip.lifted = true;
      tip.flowTarget = 0;
    }
  }

  /** Strongest output among the points whose id starts with `prefix`, 0..1. */
  levelOf(prefix: string): number {
    let level = 0;
    for (const [id, tip] of this.tips) if (id.startsWith(prefix)) level = Math.max(level, tip.level);
    return level;
  }

  /** Where one point is, how it is moving and how much it is putting out. */
  motion(id: string): Motion | null {
    const tip = this.tips.get(id);
    if (!tip) return null;
    return {
      x: tip.px,
      y: tip.py,
      vx: tip.vx,
      vy: tip.vy,
      speed: Math.hypot(tip.vx, tip.vy),
      level: tip.level,
      pigment: tip.pigment,
    };
  }

  /** Ids of the live points whose id starts with `prefix`. */
  ids(prefix: string): string[] {
    return [...this.tips.keys()].filter((id) => id.startsWith(prefix));
  }

  liftAll(prefix: string): void {
    for (const id of this.tips.keys()) if (id.startsWith(prefix)) this.lift(id);
  }

  /**
   * A heavy drop that sinks and blooms, thrown with a spray of fine
   * droplets. `power` is 1 for a quick pinch and more for a charged one.
   */
  drop(x: number, y: number, pigment: 0 | 1, power = 1): void {
    this.onDrop(x, y, power);
    const fy = 1 - y;
    const scale = this.scale * (0.85 + 0.3 * power);
    const dot = { ax: x, ay: fy, bx: x, by: fy };
    this.fluid.addInk(dot, 0.016 * scale, 3.2, pigment, 0.4, false, 2.2);
    this.fluid.addInk(dot, 0.007 * scale, 1.4, pigment, 0.0, false);
    // A narrow downward jet through the middle rolls the drop up into a
    // mushroom cap; a brief swell opens it out.
    this.fluid.addPush(dot, 0.015 * scale, 0, -1.05 * (0.8 + 0.2 * power), false);
    this.fluid.addSwell(x, fy, 0.02 * scale, 14 + 6 * (power - 1), 0.35);

    // Satellites: small beads flung outward, mostly sideways and up.
    const aspect = this.fluid.aspect;
    const count = Math.round(7 + 5 * power);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const reach = (0.035 + 0.075 * Math.random() * Math.sqrt(power)) * this.scale;
      const cx = Math.cos(angle);
      const cy = Math.sin(angle) * 0.75 + 0.25;
      const sx = x + (cx * reach) / aspect;
      const sy = fy + cy * reach;
      const bead = { ax: sx, ay: sy, bx: sx, by: sy };
      const size = (0.0016 + 0.0026 * Math.random()) * this.scale;
      this.fluid.addInk(bead, size, 1.1 + 1.2 * Math.random(), pigment, 0, false, 1.6);
      this.fluid.addPush(bead, size * 3, cx * 0.5, cy * 0.5, false);
    }
  }

  /** Pigment gathering at a held pinch before it is let go. */
  gather(x: number, y: number, pigment: 0 | 1, charge: number, dt: number): void {
    const fy = 1 - y;
    const dot = { ax: x, ay: fy, bx: x, by: fy };
    this.fluid.addInk(dot, (0.004 + 0.008 * charge) * this.scale, 3.0 * dt, pigment, 0.2, false, 1.5);
  }

  /**
   * Two pinches at once: a ring of beads in alternating pigments, set
   * spinning so the two marble together.
   */
  burst(x: number, y: number): void {
    const fy = 1 - y;
    const aspect = this.fluid.aspect;
    const beads = 12;
    for (let i = 0; i < beads; i++) {
      const angle = (i / beads) * Math.PI * 2;
      const cx = Math.cos(angle);
      const cy = Math.sin(angle);
      const reach = 0.075 * this.scale;
      const bx = x + (cx * reach) / aspect;
      const by = fy + cy * reach;
      const bead = { ax: bx, ay: by, bx, by };
      this.fluid.addInk(bead, 0.0075 * this.scale, 2.4, (i % 2) as 0 | 1, 0.3, false, 1.8);
      // Mostly around the ring, a little outward.
      this.fluid.addPush(bead, 0.028 * this.scale, -cy * 0.6 + cx * 0.2, cx * 0.6 + cy * 0.2, false);
    }
    this.fluid.addSwell(x, fy, 0.03 * this.scale, 16, 0.4);
  }

  /** Advances every pen by one displayed frame and lays down its ink. */
  update(dt: number): void {
    const s = this.settings;
    const aspect = this.fluid.aspect;
    const follow = 1 - Math.exp(-dt / 0.028);
    const ease = 1 - Math.exp(-dt / 0.11);

    this.clock += dt;
    for (const [id, tip] of this.tips) {
      // A point that has gone quiet (a resting mouse, a lost hand) lets go.
      if (this.clock - tip.heard > QUIET_SECONDS) {
        tip.lifted = true;
        tip.flowTarget = 0;
      }
      const nx = tip.px + (tip.fx - tip.px) * follow;
      const ny = tip.py + (tip.fy - tip.py) * follow;
      const vx = ((nx - tip.px) * aspect) / dt;
      const vy = (ny - tip.py) / dt;
      const speed = Math.hypot(vx, vy);
      tip.vx = vx;
      tip.vy = vy;
      const stroke = { ax: tip.px, ay: 1 - tip.py, bx: nx, by: 1 - ny };
      const length = speed * dt;
      tip.px = nx;
      tip.py = ny;

      tip.flow += (tip.flowTarget - tip.flow) * ease;
      if (tip.lifted && tip.flow < 0.02) {
        this.tips.delete(id);
        continue;
      }
      if (tip.flow < 0.01) {
        tip.level = 0;
        continue;
      }
      const lively = smoothstep(0.05, 1.6, speed);
      tip.level = tip.flow * (0.25 + 0.75 * lively);

      // Amounts are scaled by the distance covered so that what is left
      // behind does not depend on how fast the tip moved or the frame rate.
      const per = (radius: number) => length / (radius * Math.sqrt(Math.PI));
      if (tip.kind === 'ink') {
        const density = s.lineDensity * (0.7 + 0.75 * lively);
        const radius = s.inkRadius * this.scale * this.widthGain * (1 + 0.25 * lively);
        const amount = density * per(radius) + s.seep * dt;
        this.fluid.addInk(stroke, radius, amount * tip.flow, tip.pigment, 0.3, true, 2.0, tip.grainPhase);
        // A wide, faint veil around the core, as ink sheds into the water.
        this.fluid.addInk(stroke, radius * 2.2, 0.04 * density * per(radius * 2.2) * tip.flow, tip.pigment, 0.6, true);
        const reach = s.pushRadius * this.scale;
        const push = s.push * per(reach) * tip.flow;
        this.fluid.addPush(stroke, reach, vx * push, -vy * push, true);
      } else {
        const reach = 0.06 * this.scale;
        const push = 0.55 * per(reach) * tip.flow;
        this.fluid.addPush(stroke, reach, vx * push, -vy * push, true);
      }
    }
  }
}
