// A stable-fluids style solver on the GPU: body forces, self-advection,
// pressure projection, then pigment transport with a MacCormack corrector
// so thin filaments survive instead of smearing away.

import { GL, Program, Screen, Swap, Target, createTarget, deleteTarget } from './gl';
import * as S from './shaders/sim';

export interface FluidSettings {
  /** Vorticity confinement strength (1/s). */
  confinement: number;
  /** How strongly pigment sinks (stage-heights / s^2 per unit density). */
  weight: number;
  /** Ambient drift acceleration. */
  drift: number;
  /** Fraction of velocity that survives one second. */
  velocityKeep: number;
  /** Fraction of pigment that survives one second. */
  pigmentKeep: number;
  /** Pigment removed per second regardless of amount; clears faint residue. */
  pigmentLoss: number;
  /** Jacobi iterations per step. */
  iterations: number;
}

export const DEFAULT_SETTINGS: FluidSettings = {
  confinement: 4,
  weight: 0.1,
  drift: 0.004,
  velocityKeep: 0.6,
  pigmentKeep: 0.94,
  pigmentLoss: 0.004,
  iterations: 36,
};

interface Swell {
  x: number;
  y: number;
  radius: number;
  strength: number;
  life: number;
  span: number;
}

export interface Stroke {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

const CLEAR_SECONDS = 2.2;

export class Fluid {
  readonly settings: FluidSettings = { ...DEFAULT_SETTINGS };
  readonly aspect: number;

  private velocity: Swap;
  private pigment: Swap;
  private pressure: Swap;
  private divergence: Target;
  private curl: Target;
  private haze: Swap;
  private hazeWide: Swap;

  private readonly trace: Program;
  private readonly correct: Program;
  private readonly curlPass: Program;
  private readonly forces: Program;
  private readonly splat: Program;
  private readonly divergencePass: Program;
  private readonly pressurePass: Program;
  private readonly project: Program;
  private readonly reduce: Program;
  private readonly blur: Program;
  private readonly dissolve: Program;

  private readonly scratch = new Map<Swap, Target>();
  private readonly sources = new Float32Array(16);
  private swells: Swell[] = [];
  private clearing = 0;
  private time = 0;
  private seed = 1;

  constructor(
    private readonly gl: GL,
    private readonly screen: Screen,
    readonly simW: number,
    readonly simH: number,
    readonly inkW: number,
    readonly inkH: number,
  ) {
    this.aspect = simW / simH;
    this.velocity = new Swap(gl, simW, simH, 2, true);
    this.pressure = new Swap(gl, simW, simH, 1, false);
    this.divergence = createTarget(gl, simW, simH, 1, false);
    this.curl = createTarget(gl, simW, simH, 1, false);
    this.pigment = new Swap(gl, inkW, inkH, 4, true);
    this.haze = new Swap(gl, inkW >> 2, inkH >> 2, 4, true);
    this.hazeWide = new Swap(gl, inkW >> 3, inkH >> 3, 4, true);

    this.trace = new Program(gl, S.ADVECT_TRACE);
    this.correct = new Program(gl, S.ADVECT_CORRECT);
    this.curlPass = new Program(gl, S.CURL);
    this.forces = new Program(gl, S.FORCES);
    this.splat = new Program(gl, S.SPLAT);
    this.divergencePass = new Program(gl, S.DIVERGENCE);
    this.pressurePass = new Program(gl, S.PRESSURE);
    this.project = new Program(gl, S.PROJECT);
    this.reduce = new Program(gl, S.REDUCE);
    this.blur = new Program(gl, S.BLUR);
    this.dissolve = new Program(gl, S.DISSOLVE);
  }

  get pigmentTexture(): WebGLTexture {
    return this.pigment.read.tex;
  }

  /** Pigment blurred to roughly 1% of the stage height. */
  get hazeTexture(): WebGLTexture {
    return this.haze.read.tex;
  }

  /** Pigment blurred to roughly 3% of the stage height. */
  get wideHazeTexture(): WebGLTexture {
    return this.hazeWide.read.tex;
  }

  get isClearing(): boolean {
    return this.clearing > 0;
  }

  /** Frees the grids; the instance must not be used afterwards. */
  dispose(): void {
    const gl = this.gl;
    for (const pair of [this.velocity, this.pigment, this.pressure, this.haze, this.hazeWide]) pair.dispose(gl);
    for (const t of [this.divergence, this.curl, ...this.scratch.values()]) deleteTarget(gl, t);
    this.scratch.clear();
  }

  /** Starts a slow dissolve of everything in the water. */
  clear(): void {
    this.clearing = CLEAR_SECONDS;
  }

  private addCapsule(
    target: Target,
    s: Stroke,
    radius: number,
    value: [number, number, number, number],
    hardness: number,
    grain: number,
    swept: boolean,
    streak = -1,
  ): void {
    const gl = this.gl;
    // Only touch the pixels the capsule can reach.
    const reach = radius * (hardness > 1 ? 1.6 : 3.2);
    const rx = reach / this.aspect;
    const x0 = Math.max(0, Math.floor((Math.min(s.ax, s.bx) - rx) * target.w));
    const x1 = Math.min(target.w, Math.ceil((Math.max(s.ax, s.bx) + rx) * target.w));
    const y0 = Math.max(0, Math.floor((Math.min(s.ay, s.by) - reach) * target.h));
    const y1 = Math.min(target.h, Math.ceil((Math.max(s.ay, s.by) + reach) * target.h));
    if (x1 <= x0 || y1 <= y0) return;

    this.seed = (this.seed * 1.618 + 17.3) % 997;
    this.splat
      .use()
      .v2('uA', s.ax, s.ay)
      .v2('uB', s.bx, s.by)
      .f('uAspect', this.aspect)
      .f('uRadius', radius)
      .f('uHardness', hardness)
      .f('uSwept', swept ? 1 : 0)
      .f('uStreak', streak)
      .f('uGrain', grain)
      .f('uSeed', this.seed)
      .v4('uValue', value);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, y0, x1 - x0, y1 - y0);
    this.screen.draw(target);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
  }

  /**
   * Deposits pigment along a segment. `channel` picks which hand's ink.
   * With `swept`, `amount` is spread as the trail of a moving dot; a `streak`
   * phase of zero or more gives that trail the striations of a brush mark.
   */
  addInk(
    s: Stroke,
    radius: number,
    amount: number,
    channel: 0 | 1,
    grain: number,
    swept: boolean,
    hardness = 1,
    streak = -1,
  ): void {
    const value: [number, number, number, number] = channel === 0 ? [amount, 0, 0, 0] : [0, amount, 0, 0];
    this.addCapsule(this.pigment.read, s, radius, value, hardness, grain, swept, streak);
  }

  /** Adds momentum along a segment. */
  addPush(s: Stroke, radius: number, vx: number, vy: number, swept: boolean): void {
    this.addCapsule(this.velocity.read, s, radius, [vx, vy, 0, 0], 1, 0, swept);
  }

  /** Makes the water swell outward from a point for a moment. */
  addSwell(x: number, y: number, radius: number, strength: number, seconds: number): void {
    if (this.swells.length >= 4) this.swells.shift();
    this.swells.push({ x, y, radius, strength, life: seconds, span: seconds });
  }

  step(dt: number): void {
    const gl = this.gl;
    const st = this.settings;
    const texel: [number, number] = [1 / this.simW, 1 / this.simH];
    this.time += dt;
    gl.disable(gl.BLEND);

    // 1. Vorticity, then body forces.
    this.curlPass.use().tex('uVelocity', this.velocity.read.tex, 0).v2('uTexel', texel[0], texel[1]);
    this.screen.draw(this.curl);

    this.forces
      .use()
      .tex('uVelocity', this.velocity.read.tex, 0)
      .tex('uCurl', this.curl.tex, 1)
      .tex('uHaze', this.haze.read.tex, 2)
      .v2('uTexel', texel[0], texel[1])
      .f('uDt', dt)
      .f('uTime', this.time)
      .f('uAspect', this.aspect)
      .f('uConfinement', st.confinement)
      .f('uWeight', st.weight)
      .f('uDrift', st.drift)
      .f('uDamping', Math.pow(st.velocityKeep, dt))
      .f('uSpeedLimit', 2.5);
    this.screen.draw(this.velocity.write);
    this.velocity.swap();

    // 2. Velocity carries itself.
    this.advect(this.velocity, this.velocity.read.tex, dt, 0.25, 1, 0, 100, 0);

    // 3. Projection onto a divergence-free field.
    const sources = this.sources.fill(0);
    const cell = 1 / this.simH;
    this.swells = this.swells.filter((w) => w.life > 0);
    this.swells.forEach((w, i) => {
      const phase = w.life / w.span;
      sources.set([w.x, w.y, w.radius, w.strength * cell * phase * phase], i * 4);
      w.life -= dt;
    });
    this.divergencePass
      .use()
      .tex('uVelocity', this.velocity.read.tex, 0)
      .v2('uTexel', texel[0], texel[1])
      .f('uAspect', this.aspect)
      .v4s('uSource', sources);
    this.screen.draw(this.divergence);

    this.pressurePass.use().tex('uDivergence', this.divergence.tex, 1).v2('uTexel', texel[0], texel[1]);
    for (let i = 0; i < st.iterations; i++) {
      this.pressurePass.tex('uPressure', this.pressure.read.tex, 0);
      this.screen.draw(this.pressure.write);
      this.pressure.swap();
    }

    this.project
      .use()
      .tex('uVelocity', this.velocity.read.tex, 0)
      .tex('uPressure', this.pressure.read.tex, 1)
      .v2('uTexel', texel[0], texel[1]);
    this.screen.draw(this.velocity.write);
    this.velocity.swap();

    // 4. Pigment rides the flow.
    this.advect(
      this.pigment,
      this.velocity.read.tex,
      dt,
      1,
      Math.pow(st.pigmentKeep, dt),
      st.pigmentLoss * dt,
      8,
      Math.min(1, 1.2 * dt),
    );

    // 5. Blurred copies for shading and for the pigment's weight.
    this.buildHaze();

    if (this.clearing > 0) {
      const phase = 1 - this.clearing / CLEAR_SECONDS;
      const rate = 0.6 + 5.5 * phase * phase;
      this.dissolve
        .use()
        .tex('uSource', this.pigment.read.tex, 0)
        .tex('uSoft', this.haze.read.tex, 1)
        .f('uBlend', Math.min(1, dt * (2 + 10 * phase)))
        .f('uKeep', Math.exp(-rate * dt));
      this.screen.draw(this.pigment.write);
      this.pigment.swap();
      this.clearing -= dt;
      if (this.clearing <= 0) {
        this.clearing = 0;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.pigment.read.fbo);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }
  }

  private advect(
    field: Swap,
    velocity: WebGLTexture,
    dt: number,
    sharpen: number,
    keep: number,
    loss: number,
    ceiling: number,
    edgeLoss: number,
  ): void {
    // Trace into a scratch buffer, then correct into the write target.
    const scratch = this.scratchFor(field);
    this.trace
      .use()
      .tex('uVelocity', velocity, 0)
      .tex('uSource', field.read.tex, 1)
      .f('uDt', dt)
      .f('uAspect', this.aspect);
    this.screen.draw(scratch);

    this.correct
      .use()
      .tex('uVelocity', velocity, 0)
      .tex('uSource', field.read.tex, 1)
      .tex('uTraced', scratch.tex, 2)
      .f('uDt', dt)
      .f('uAspect', this.aspect)
      .f('uSharpen', sharpen)
      .f('uKeep', keep)
      .f('uLoss', loss)
      .f('uCeiling', ceiling)
      .f('uEdgeLoss', edgeLoss);
    this.screen.draw(field.write);
    field.swap();
  }

  private scratchFor(field: Swap): Target {
    let t = this.scratch.get(field);
    if (!t) {
      const four = field === this.pigment;
      t = createTarget(this.gl, field.read.w, field.read.h, four ? 4 : 2, true);
      this.scratch.set(field, t);
    }
    return t;
  }

  private buildHaze(): void {
    const h = this.haze;
    this.reduce
      .use()
      .tex('uSource', this.pigment.read.tex, 0)
      .v2('uSourceTexel', 1 / this.inkW, 1 / this.inkH);
    this.screen.draw(h.write);
    h.swap();
    this.blurInPlace(h, 1.2);

    const wide = this.hazeWide;
    this.reduce
      .use()
      .tex('uSource', h.read.tex, 0)
      .v2('uSourceTexel', 0.5 / h.read.w, 0.5 / h.read.h);
    this.screen.draw(wide.write);
    wide.swap();
    this.blurInPlace(wide, 1.6);
  }

  private blurInPlace(field: Swap, spread: number): void {
    this.blur.use().tex('uSource', field.read.tex, 0).v2('uStep', spread / field.read.w, 0);
    this.screen.draw(field.write);
    field.swap();
    this.blur.tex('uSource', field.read.tex, 0).v2('uStep', 0, spread / field.read.h);
    this.screen.draw(field.write);
    field.swap();
  }
}
