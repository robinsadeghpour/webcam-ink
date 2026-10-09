// Draws the final picture: paper or camera underneath, pigment on top.

import { Fluid } from './fluid';
import { GL, Program, Screen, createImageTexture } from './gl';
import { Palette } from './palettes';
import { COMPOSITE, PAPER } from './shaders/look';

export type Backdrop = HTMLVideoElement | HTMLCanvasElement;

export class View {
  private readonly composite: Program;
  private readonly paperPass: Program;
  private readonly paperTex: WebGLTexture;
  private readonly paperFbo: WebGLFramebuffer;
  private readonly videoTex: WebGLTexture;
  private readonly overlayTex: WebGLTexture;
  private overlayOn = false;
  private overlayMasked = false;
  private readonly ripples: { x: number; y: number; born: number; height: number }[] = [];
  private readonly rippleData = new Float32Array(16);
  private videoTexel: [number, number] = [0, 0];
  private paperW = 0;
  private paperH = 0;
  private fit: [number, number, number, number] = [1, 1, 0, 0];
  private frame = 0;

  constructor(
    private readonly gl: GL,
    private readonly screen: Screen,
  ) {
    this.composite = new Program(gl, COMPOSITE);
    this.paperPass = new Program(gl, PAPER);
    this.paperTex = createImageTexture(gl);
    this.paperFbo = gl.createFramebuffer()!;
    this.videoTex = createImageTexture(gl);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.overlayTex = createImageTexture(gl);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /**
   * Starts a ring on the water at a stage position (y down). `height` is how
   * far it bends the picture, in stage heights; about 0.006 is a clear ripple.
   */
  addRipple(x: number, y: number, height: number, time: number): void {
    if (this.ripples.length >= 4) this.ripples.shift();
    this.ripples.push({ x, y: 1 - y, born: time, height });
  }

  /**
   * Uploads the tracking overlay, or switches it off with null. A `masked`
   * overlay holds masks for the shader to colour; otherwise it is drawn as is.
   */
  setOverlay(source: HTMLCanvasElement | null, masked = false): void {
    this.overlayOn = source !== null;
    this.overlayMasked = masked;
    if (!source) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.overlayTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // Blurred copies give the colour overlay its glow.
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Re-renders the paper sheet when the canvas size changes. */
  private ensurePaper(w: number, h: number): void {
    if (w === this.paperW && h === this.paperH) return;
    const gl = this.gl;
    this.paperW = w;
    this.paperH = h;
    gl.bindTexture(gl.TEXTURE_2D, this.paperTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.paperFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.paperTex, 0);
    this.paperPass.use().v2('uSize', w, h);
    this.screen.draw({ tex: this.paperTex, fbo: this.paperFbo, w, h });
  }

  /**
   * Uploads the current camera frame (or stand-in canvas) and works out how
   * to crop it to cover the stage. `mirror` flips it like a mirror.
   */
  setBackdrop(source: Backdrop, mirror: boolean, stageAspect: number): void {
    const gl = this.gl;
    const w = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const h = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    if (!w || !h) return;
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // Small copies of the frame tell the overlay how bright the picture is.
    gl.generateMipmap(gl.TEXTURE_2D);

    this.videoTexel = [1 / w, 1 / h];
    const sourceAspect = w / h;
    let sx = 1;
    let sy = 1;
    if (sourceAspect > stageAspect) sx = stageAspect / sourceAspect;
    else sy = sourceAspect / stageAspect;
    if (mirror) this.fit = [-sx, sy, 0.5 + sx / 2, 0.5 - sy / 2];
    else this.fit = [sx, sy, 0.5 - sx / 2, 0.5 - sy / 2];
  }

  /**
   * `mix` describes the background: `from` and `to` are 0 for paper and 1 for
   * the camera. While a switch runs, `wipe` gives its centre (stage
   * coordinates, y down) and how far it has spread, in stage heights.
   */
  draw(
    fluid: Fluid,
    palette: Palette,
    mix: { from: number; to: number; wipe: { x: number; y: number; radius: number } | null },
    time: number,
    w: number,
    h: number,
  ): void {
    const gl = this.gl;
    this.ensurePaper(w, h);
    this.frame = (this.frame + 1) % 1024;

    // Rings spread at a steady speed and flatten as they go.
    const RIPPLE_SECONDS = 1.5;
    this.rippleData.fill(0);
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      if (time - this.ripples[i].born > RIPPLE_SECONDS || time < this.ripples[i].born) this.ripples.splice(i, 1);
    }
    this.ripples.forEach((r, i) => {
      const age = (time - r.born) / RIPPLE_SECONDS;
      this.rippleData.set([r.x, r.y, 0.03 + age * 1.1, r.height * (1 - age) * (1 - age)], i * 4);
    });
    gl.disable(gl.BLEND);
    this.composite
      .use()
      .tex('uPigment', fluid.pigmentTexture, 0)
      .tex('uHaze', fluid.hazeTexture, 1)
      .tex('uWide', fluid.wideHazeTexture, 2)
      .tex('uPaper', this.paperTex, 3)
      .tex('uVideo', this.videoTex, 4)
      .tex('uOverlay', this.overlayTex, 5)
      .f('uOverlayOn', this.overlayOn ? 1 : 0)
      .f('uOverlayMasked', this.overlayMasked ? 1 : 0)
      .v4s('uRipple', this.rippleData)
      .v4('uWipe', mix.wipe ? [mix.wipe.x, 1 - mix.wipe.y, mix.wipe.radius, 1] : [0.5, 0.5, 100, 0])
      .v2('uMixes', mix.from, mix.to)
      .v2('uVideoTexel', this.videoTexel[0], this.videoTexel[1])
      .v2('uHazeTexel', 4 / fluid.inkW, 4 / fluid.inkH)
      .v4('uVideoFit', this.fit)
      .f('uAspect', fluid.aspect)
      .f('uTime', time)
      .f('uFrame', this.frame)
      .v3('uPaperTint', palette.paper)
      .v3('uAbsorbA', palette.first.absorb)
      .v3('uAbsorbB', palette.second.absorb)
      .v3('uBodyA', palette.first.body)
      .v3('uBodyB', palette.second.body)
      .v2('uCover', palette.first.cover, palette.second.cover)
      .f('uSheenB', palette.sheen);
    this.screen.draw(null, w, h);
  }
}
