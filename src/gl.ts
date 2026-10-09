// Thin WebGL2 helpers: programs, render targets, a fullscreen triangle.

export type GL = WebGL2RenderingContext;

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

function compile(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    const numbered = source
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(3)}  ${line}`)
      .join('\n');
    gl.deleteShader(shader);
    throw new Error(`Shader failed to compile:\n${log}\n${numbered}`);
  }
  return shader;
}

export class Program {
  readonly handle: WebGLProgram;
  private readonly locations = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private readonly gl: GL,
    fragment: string,
    vertex: string = FULLSCREEN_VS,
  ) {
    const program = gl.createProgram()!;
    const vs = compile(gl, gl.VERTEX_SHADER, vertex);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program failed to link: ${gl.getProgramInfoLog(program)}`);
    }
    this.handle = program;
  }

  use(): this {
    this.gl.useProgram(this.handle);
    return this;
  }

  private loc(name: string): WebGLUniformLocation | null {
    let l = this.locations.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.handle, name);
      this.locations.set(name, l);
    }
    return l;
  }

  f(name: string, x: number): this {
    this.gl.uniform1f(this.loc(name), x);
    return this;
  }

  v2(name: string, x: number, y: number): this {
    this.gl.uniform2f(this.loc(name), x, y);
    return this;
  }

  v3(name: string, v: ArrayLike<number>): this {
    this.gl.uniform3f(this.loc(name), v[0], v[1], v[2]);
    return this;
  }

  v4(name: string, v: ArrayLike<number>): this {
    this.gl.uniform4f(this.loc(name), v[0], v[1], v[2], v[3]);
    return this;
  }

  v4s(name: string, values: Float32Array): this {
    this.gl.uniform4fv(this.loc(name), values);
    return this;
  }

  /** Binds a texture to a unit and points the sampler at it. */
  tex(name: string, texture: WebGLTexture, unit: number): this {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.loc(name), unit);
    return this;
  }
}

export interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

export type Channels = 1 | 2 | 4;

const FORMATS: Record<Channels, { internal: (gl: GL) => number; format: (gl: GL) => number }> = {
  1: { internal: (gl) => gl.R16F, format: (gl) => gl.RED },
  2: { internal: (gl) => gl.RG16F, format: (gl) => gl.RG },
  4: { internal: (gl) => gl.RGBA16F, format: (gl) => gl.RGBA },
};

/** A half-float render target, cleared to zero. */
export function createTarget(gl: GL, w: number, h: number, channels: Channels, linear: boolean): Target {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const filter = linear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const f = FORMATS[channels];
  gl.texImage2D(gl.TEXTURE_2D, 0, f.internal(gl), w, h, 0, f.format(gl), gl.HALF_FLOAT, null);

  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('Half-float render targets are not supported on this device.');
  }
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return { tex, fbo, w, h };
}

export function deleteTarget(gl: GL, t: Target): void {
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fbo);
}

/** A pair of targets for read-then-write passes. */
export class Swap {
  read: Target;
  write: Target;

  constructor(gl: GL, w: number, h: number, channels: Channels, linear: boolean) {
    this.read = createTarget(gl, w, h, channels, linear);
    this.write = createTarget(gl, w, h, channels, linear);
  }

  swap(): void {
    const t = this.read;
    this.read = this.write;
    this.write = t;
  }

  dispose(gl: GL): void {
    deleteTarget(gl, this.read);
    deleteTarget(gl, this.write);
  }
}

/** One oversized triangle that covers the viewport. */
export class Screen {
  private readonly vao: WebGLVertexArrayObject;

  constructor(private readonly gl: GL) {
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** Draws the bound program into a target, or the canvas when target is null. */
  draw(target: Target | null, canvasW = 0, canvasH = 0): void {
    const gl = this.gl;
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvasW, canvasH);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

/** An 8-bit texture for images, canvases and video frames. */
export function createImageTexture(gl: GL): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
  return tex;
}
