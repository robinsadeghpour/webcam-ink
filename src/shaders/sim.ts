// Fluid solver passes.
//
// Conventions
//   - Fields live on a regular grid with square cells; vUv spans [0,1]^2 and
//     uAspect is width / height of the stage.
//   - Velocity is stored in stage-heights per second, so a value of 1.0 on
//     either axis crosses the full height of the stage in one second.
//   - Pressure is stored pre-divided by the cell size, which makes the
//     projection independent of the velocity units.

const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
`;

// Small integer hash and value noise shared by a few passes.
export const NOISE = /* glsl */ `
uint mixBits(uvec2 p) {
  uint n = p.x * 0x9E3779B1u ^ (p.y * 0x85EBCA77u + 0x165667B1u);
  n ^= n >> 15; n *= 0x2C1B3C6Du;
  n ^= n >> 12; n *= 0x297A2D39u;
  n ^= n >> 15;
  return n;
}
float hash(vec2 cell) {
  return float(mixBits(uvec2(ivec2(cell) + 32768))) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

/** First half of advection: trace each cell back along the flow. */
export const ADVECT_TRACE = /* glsl */ `${HEADER}
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform float uDt;
uniform float uAspect;
out vec4 outColor;
void main() {
  vec2 step = uDt * texture(uVelocity, vUv).xy * vec2(1.0 / uAspect, 1.0);
  outColor = texture(uSource, vUv - step);
}`;

/**
 * Second half: MacCormack correction. Trace the first estimate forward
 * again, measure how far that round trip drifted from the original field,
 * and add half of the error back. The result is limited to the range of the
 * four texels around the departure point so it cannot overshoot.
 */
export const ADVECT_CORRECT = /* glsl */ `${HEADER}
uniform sampler2D uVelocity;
uniform sampler2D uSource;   // field before advection
uniform sampler2D uTraced;   // output of the trace pass
uniform float uDt;
uniform float uAspect;
uniform float uSharpen;      // 0 = plain semi-Lagrangian, 1 = full correction
uniform float uKeep;         // multiplicative decay for this step
uniform float uLoss;         // subtractive decay for this step
uniform float uCeiling;      // upper bound on stored values
uniform float uEdgeLoss;     // extra decay close to the walls, per step
out vec4 outColor;
void main() {
  vec2 step = uDt * texture(uVelocity, vUv).xy * vec2(1.0 / uAspect, 1.0);
  vec4 traced = texture(uTraced, vUv);
  vec4 roundTrip = texture(uTraced, vUv + step);
  vec4 original = texture(uSource, vUv);
  vec4 value = traced + 0.5 * uSharpen * (original - roundTrip);

  ivec2 size = textureSize(uSource, 0);
  vec2 p = (vUv - step) * vec2(size) - 0.5;
  ivec2 i0 = clamp(ivec2(floor(p)), ivec2(0), size - 1);
  ivec2 i1 = min(i0 + 1, size - 1);
  vec4 a = texelFetch(uSource, i0, 0);
  vec4 b = texelFetch(uSource, ivec2(i1.x, i0.y), 0);
  vec4 c = texelFetch(uSource, ivec2(i0.x, i1.y), 0);
  vec4 d = texelFetch(uSource, i1, 0);
  value = clamp(value, min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));

  // Let what reaches the walls thin out instead of piling up against them.
  vec2 wall = min(vUv, 1.0 - vUv);
  float nearWall = 1.0 - smoothstep(0.0, 0.05, min(wall.x * uAspect, wall.y));
  value = value * uKeep * (1.0 - uEdgeLoss * nearWall);
  value = sign(value) * max(abs(value) - uLoss, 0.0);
  outColor = clamp(value, -uCeiling, uCeiling);
}`;

/** Scalar vorticity of the velocity field, in cell units. */
export const CURL = /* glsl */ `${HEADER}
uniform sampler2D uVelocity;
uniform vec2 uTexel;
out vec4 outColor;
void main() {
  float l = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
  float r = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
  float b = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
  float t = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
  outColor = vec4(0.5 * ((r - l) - (t - b)), 0.0, 0.0, 1.0);
}`;

/**
 * Body forces: vorticity confinement, the weight of the pigment, and a slow
 * divergence-free drift that keeps still water from looking frozen.
 */
export const FORCES = /* glsl */ `${HEADER}
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform sampler2D uHaze;     // blurred pigment, used as density
uniform vec2 uTexel;
uniform float uDt;
uniform float uTime;
uniform float uAspect;
uniform float uConfinement;
uniform float uWeight;
uniform float uDrift;
uniform float uDamping;
uniform float uSpeedLimit;
out vec4 outColor;
${NOISE}
float stream(vec2 p) {
  return vnoise(p * 2.3 + vec2(0.0, uTime * 0.045))
       + 0.5 * vnoise(p * 5.1 - vec2(uTime * 0.06, 3.7));
}
void main() {
  vec2 v = texture(uVelocity, vUv).xy;

  // Confinement: push along the direction that tightens existing swirls.
  float wl = abs(texture(uCurl, vUv - vec2(uTexel.x, 0.0)).r);
  float wr = abs(texture(uCurl, vUv + vec2(uTexel.x, 0.0)).r);
  float wb = abs(texture(uCurl, vUv - vec2(0.0, uTexel.y)).r);
  float wt = abs(texture(uCurl, vUv + vec2(0.0, uTexel.y)).r);
  float w = texture(uCurl, vUv).r;
  vec2 toward = vec2(wr - wl, wt - wb);
  toward /= length(toward) + 1e-6;
  vec2 force = uConfinement * w * vec2(toward.y, -toward.x);

  // Pigment is slightly heavier than water.
  vec4 haze = texture(uHaze, vUv);
  float density = haze.r + haze.g;
  force.y -= uWeight * density / (1.0 + 0.9 * density);

  // Ambient drift: the curl of a scalar stream function.
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  float e = 0.02;
  float sx = stream(p + vec2(e, 0.0)) - stream(p - vec2(e, 0.0));
  float sy = stream(p + vec2(0.0, e)) - stream(p - vec2(0.0, e));
  force += uDrift * vec2(sy, -sx) / (2.0 * e);

  v += uDt * force;
  v *= uDamping;
  float speed = length(v);
  v *= min(1.0, uSpeedLimit / max(speed, 1e-6));
  outColor = vec4(v, 0.0, 1.0);
}`;

/**
 * Adds a soft mark along a line segment to a field. Drawn with additive
 * blending, so only the increment is written.
 *
 * With uSwept = 0 the mark is a capsule: full strength on the segment,
 * falling off with distance from it.
 * With uSwept = 1 it is the exact trail left by a gaussian dot travelling
 * from A to B at constant speed. Integrating exp(-|p - A - t(B-A)|^2 / r^2)
 * over t in [0,1] gives a gaussian across the stroke times a difference of
 * error functions along it, so successive segments join without beading.
 */
export const SPLAT = /* glsl */ `${HEADER}
uniform vec2 uA;
uniform vec2 uB;
uniform float uAspect;
uniform float uRadius;
uniform float uHardness;   // 1 = gaussian, higher = flatter top with a crisper edge
uniform float uSwept;
uniform float uStreak;     // >= 0: phase of brush-like striations along the trail
uniform float uGrain;      // 0..1 how much the deposit is broken up
uniform float uSeed;
uniform vec4 uValue;
out vec4 outColor;
${NOISE}
// Closed-form approximation of the error function.
float erfApprox(float x) {
  float x2 = x * x;
  float k = 0.147;
  return sign(x) * sqrt(1.0 - exp(-x2 * (1.2732395 + k * x2) / (1.0 + k * x2)));
}
void main() {
  vec2 scale = vec2(uAspect, 1.0);
  vec2 p = vUv * scale;
  vec2 a = uA * scale;
  vec2 ab = uB * scale - a;
  vec2 ap = p - a;
  float len = length(ab);
  float falloff;
  if (uSwept > 0.5 && len > uRadius * 0.02) {
    vec2 dir = ab / len;
    float along = dot(ap, dir);
    float across = dot(ap, vec2(-dir.y, dir.x));
    float trail = (0.8862269 * uRadius / len) *
        (erfApprox(along / uRadius) - erfApprox((along - len) / uRadius));
    float side = across / uRadius;
    falloff = exp(-pow(side * side, uHardness)) * trail;
    if (uStreak >= 0.0) {
      // Bristle marks: uneven across the stroke, continuous along it.
      float bristles = vnoise(vec2(side * 2.1 + uStreak, uStreak * 3.0)) * 0.65
                     + vnoise(vec2(side * 5.0 - uStreak, 7.0)) * 0.35;
      falloff *= 0.2 + 1.7 * bristles;
    }
  } else {
    float along = clamp(dot(ap, ab) / max(len * len, 1e-10), 0.0, 1.0);
    vec2 off = ap - ab * along;
    float q = dot(off, off) / (uRadius * uRadius);
    falloff = exp(-pow(q, uHardness));
  }
  float n = vnoise(p * 55.0 + uSeed) * 0.65 + vnoise(p * 140.0 - uSeed) * 0.35;
  falloff *= mix(1.0, 0.25 + 1.5 * n, uGrain);
  outColor = uValue * falloff;
}`;

/** Divergence of velocity, with solid walls and optional point sources. */
export const DIVERGENCE = /* glsl */ `${HEADER}
uniform sampler2D uVelocity;
uniform vec2 uTexel;
uniform float uAspect;
uniform vec4 uSource[4];   // xy = position, z = radius, w = strength
out vec4 outColor;
void main() {
  vec2 c = texture(uVelocity, vUv).xy;
  float l = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  float t = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
  // Reflect the normal component at the walls so nothing flows through them.
  if (vUv.x - uTexel.x < 0.0) l = -c.x;
  if (vUv.x + uTexel.x > 1.0) r = -c.x;
  if (vUv.y - uTexel.y < 0.0) b = -c.y;
  if (vUv.y + uTexel.y > 1.0) t = -c.y;
  float div = 0.5 * (r - l + t - b);

  // A positive source makes the water swell outward from a point.
  vec2 scale = vec2(uAspect, 1.0);
  for (int i = 0; i < 4; i++) {
    vec2 d = (vUv - uSource[i].xy) * scale;
    float rr = max(uSource[i].z, 1e-4);
    div -= uSource[i].w * exp(-dot(d, d) / (rr * rr));
  }
  outColor = vec4(div, 0.0, 0.0, 1.0);
}`;

/** One Jacobi relaxation step for the pressure Poisson equation. */
export const PRESSURE = /* glsl */ `${HEADER}
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexel;
out vec4 outColor;
void main() {
  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).r;
  float r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).r;
  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).r;
  float t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).r;
  float div = texture(uDivergence, vUv).r;
  outColor = vec4((l + r + b + t - div) * 0.25, 0.0, 0.0, 1.0);
}`;

/** Removes the pressure gradient, leaving a divergence-free velocity. */
export const PROJECT = /* glsl */ `${HEADER}
uniform sampler2D uVelocity;
uniform sampler2D uPressure;
uniform vec2 uTexel;
out vec4 outColor;
void main() {
  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).r;
  float r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).r;
  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).r;
  float t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).r;
  vec2 v = texture(uVelocity, vUv).xy - 0.5 * vec2(r - l, t - b);
  // Walls: no flow across the outermost cells.
  if (vUv.x < uTexel.x || vUv.x > 1.0 - uTexel.x) v.x = 0.0;
  if (vUv.y < uTexel.y || vUv.y > 1.0 - uTexel.y) v.y = 0.0;
  outColor = vec4(v, 0.0, 1.0);
}`;

/** 4x4 box reduction (four bilinear taps). */
export const REDUCE = /* glsl */ `${HEADER}
uniform sampler2D uSource;
uniform vec2 uSourceTexel;
out vec4 outColor;
void main() {
  vec2 o = uSourceTexel;
  outColor = 0.25 * (
    texture(uSource, vUv + vec2(-o.x, -o.y)) +
    texture(uSource, vUv + vec2( o.x, -o.y)) +
    texture(uSource, vUv + vec2(-o.x,  o.y)) +
    texture(uSource, vUv + vec2( o.x,  o.y)));
}`;

/** One axis of a 9-tap gaussian blur. */
export const BLUR = /* glsl */ `${HEADER}
uniform sampler2D uSource;
uniform vec2 uStep;
out vec4 outColor;
void main() {
  vec4 sum = texture(uSource, vUv) * 0.20236;
  sum += (texture(uSource, vUv + uStep) + texture(uSource, vUv - uStep)) * 0.179044;
  sum += (texture(uSource, vUv + uStep * 2.0) + texture(uSource, vUv - uStep * 2.0)) * 0.124009;
  sum += (texture(uSource, vUv + uStep * 3.0) + texture(uSource, vUv - uStep * 3.0)) * 0.067234;
  sum += (texture(uSource, vUv + uStep * 4.0) + texture(uSource, vUv - uStep * 4.0)) * 0.028532;
  outColor = sum;
}`;

/** Blends a field toward a blurred copy of itself; used while clearing. */
export const DISSOLVE = /* glsl */ `${HEADER}
uniform sampler2D uSource;
uniform sampler2D uSoft;
uniform float uBlend;
uniform float uKeep;
out vec4 outColor;
void main() {
  outColor = mix(texture(uSource, vUv), texture(uSoft, vUv), uBlend) * uKeep;
}`;
