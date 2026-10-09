// Everything about how the picture looks: the paper, the graded camera
// image, and the pass that lays pigment over them.

import { NOISE } from './sim';

const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
`;

/**
 * Sheet of handmade paper, rendered once per resize.
 * RGB is the sheet (sRGB, untinted), A is a fine tooth map that the pigment
 * later settles into.
 */
export const PAPER = /* glsl */ `${HEADER}
uniform vec2 uSize;   // stage size in design pixels
out vec4 outColor;
${NOISE}
float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amp * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    amp *= 0.5;
  }
  return sum;
}
// Long, thin fibres lying in one direction.
float fibres(vec2 p, float angle, float density) {
  float c = cos(angle), s = sin(angle);
  vec2 q = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
  float wobble = vnoise(q * vec2(0.004, 0.02)) * 40.0;
  float n = vnoise(vec2(q.x * 0.011, (q.y + wobble) * density));
  return pow(n, 14.0);
}
void main() {
  // Work in design pixels so the sheet has the same grain at any size.
  vec2 px = vUv * uSize;

  float mottle = fbm(px / 520.0) - 0.5;
  float cloud = fbm(px / 120.0 + 31.0) - 0.5;
  float tooth = vnoise(px * 0.55) * 0.6 + vnoise(px * 1.3 + 5.0) * 0.4;
  float fibre =
      fibres(px, 0.35, 0.3) +
      fibres(px + 300.0, 1.9, 0.26) +
      fibres(px + 700.0, 2.7, 0.34) * 0.7;

  float shade = 1.0 + 0.034 * mottle + 0.016 * cloud + 0.020 * (tooth - 0.5);
  vec3 sheet = vec3(0.968, 0.950, 0.912) * shade;
  sheet -= fibre * vec3(0.012, 0.014, 0.018);

  outColor = vec4(sheet, tooth);
}`;

export const COMPOSITE = /* glsl */ `${HEADER}
uniform sampler2D uPigment;
uniform sampler2D uHaze;
uniform sampler2D uWide;
uniform sampler2D uPaper;
uniform sampler2D uVideo;
uniform sampler2D uOverlay;
uniform float uOverlayOn;
uniform vec2 uVideoTexel;
uniform vec2 uHazeTexel;
uniform vec4 uVideoFit;     // uv * xy + zw maps the stage into the video frame
uniform vec2 uMixes;        // background before and after a switch: 0 = paper, 1 = camera
uniform vec4 uWipe;         // a switch spreading from xy: z = radius in stage heights, w = 1 while it runs
uniform vec4 uRipple[4];    // rings on the water: xy = centre, z = radius, w = height
uniform float uOverlayMasked;
uniform float uAspect;
uniform float uTime;
uniform float uFrame;
uniform vec3 uPaperTint;
uniform vec3 uAbsorbA;
uniform vec3 uAbsorbB;
uniform vec3 uBodyA;
uniform vec3 uBodyB;
uniform vec2 uCover;       // opacity of a thick layer, per pigment
uniform float uSheenB;      // metallic glint for the second pigment
out vec4 outColor;
${NOISE}

vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toDisplay(vec3 c) { return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Camera grade: kept close to the real picture so the person stays clear.
// A touch less colour, slightly lifted shadows, cool shadows against warm
// highlights.
vec3 grade(vec3 srgb) {
  float l = luma(srgb);
  vec3 c = mix(vec3(l), srgb, 0.86);
  c = 0.03 + c * 0.94;
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.18);
  c *= mix(vec3(0.97, 0.995, 1.03), vec3(1.025, 1.0, 0.97), smoothstep(0.1, 0.8, l));
  return toLinear(c);
}

// The camera frame is enlarged to fill a portrait stage, so it is sharpened
// a little on the way in: the picture plus its difference from a small blur.
vec3 cameraAt(vec2 uv) {
  vec3 c = texture(uVideo, uv).rgb;
  vec2 o = uVideoTexel * 1.25;
  vec3 soft = 0.25 * (
      texture(uVideo, uv + vec2(o.x, o.y)).rgb + texture(uVideo, uv + vec2(-o.x, o.y)).rgb +
      texture(uVideo, uv + vec2(o.x, -o.y)).rgb + texture(uVideo, uv - vec2(o.x, o.y)).rgb);
  return clamp(c + 0.7 * (c - soft), 0.0, 1.0);
}

// Light focused through a rippling surface: bright where two slowly
// drifting noise fields agree.
float caustics(vec2 p, float t) {
  vec2 warp = vec2(vnoise(p * 1.7 + vec2(t * 0.05, 3.1)), vnoise(p * 1.7 + vec2(8.3, -t * 0.06))) - 0.5;
  vec2 q = p + warp * 0.55;
  float a = vnoise(q * 5.5 + vec2(t * 0.11, -t * 0.07));
  float b = vnoise(q * 5.5 + vec2(-t * 0.09, t * 0.10) + 21.7);
  float c = vnoise(q * 11.0 + vec2(t * 0.14, t * 0.05) + 4.4);
  float web = 1.0 - smoothstep(0.0, 0.11, abs(a - b));
  float fine = 1.0 - smoothstep(0.0, 0.16, abs(b - c));
  return web * 0.75 + fine * 0.25;
}

float total(vec4 p) { return p.r + p.g; }

void main() {
  vec2 still = vec2(vUv.x * uAspect, vUv.y);

  // A background switch spreads out from a point behind a ragged, inky front.
  float reach = length(still - vec2(uWipe.x * uAspect, uWipe.y))
      + ((vnoise(still * 6.0) - 0.5) * 0.16 + (vnoise(still * 21.0) - 0.5) * 0.035) * uWipe.w;
  float front = exp(-pow((reach - uWipe.z) / 0.04, 2.0)) * uWipe.w;
  float videoMix = mix(uMixes.x, uMixes.y, 1.0 - smoothstep(uWipe.z - 0.025, uWipe.z + 0.025, reach));

  // Rings travelling over the water bend everything seen through them.
  vec2 wobble = vec2(0.0);
  float crest = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 d = still - vec2(uRipple[i].x * uAspect, uRipple[i].y);
    float r = length(d) + 1e-5;
    float band = exp(-pow((r - uRipple[i].z) / 0.055, 2.0));
    float wave = sin((r - uRipple[i].z) * 64.0) * band * uRipple[i].w;
    wobble += (d / r) * wave;
    crest += wave;
  }
  vec2 uv = vUv + wobble * vec2(1.0 / uAspect, 1.0);
  vec2 heights = vec2(uv.x * uAspect, uv.y);

  vec4 pigment = texture(uPigment, uv);
  vec4 haze = texture(uHaze, uv);
  vec4 wide = texture(uWide, uv);

  // Slope of the blurred pigment: used to bend what lies underneath.
  float hl = total(texture(uHaze, uv - vec2(uHazeTexel.x, 0.0)));
  float hr = total(texture(uHaze, uv + vec2(uHazeTexel.x, 0.0)));
  float hb = total(texture(uHaze, uv - vec2(0.0, uHazeTexel.y)));
  float ht = total(texture(uHaze, uv + vec2(0.0, uHazeTexel.y)));
  vec2 slope = vec2(hr - hl, ht - hb);
  vec2 bend = slope * vec2(1.0 / uAspect, 1.0);
  bend *= 0.011 / (1.0 + 2.0 * length(slope));

  // --- What is under the water -------------------------------------------
  vec4 sheet = texture(uPaper, uv + bend * 0.6);
  vec3 paper = toLinear(sheet.rgb) * uPaperTint;
  vec2 vuv = (uv + bend) * uVideoFit.xy + uVideoFit.zw;
  vec3 camera = grade(cameraAt(vuv));
  vec3 under = mix(paper, camera, videoMix);
  float tooth = texture(uPaper, uv).a;

  // Caustic shimmer, livelier where the pigment is disturbing the water.
  float c = caustics(heights + bend * 6.0, uTime);
  float shimmer = (c - 0.33) * mix(0.030, 0.022, videoMix);
  under *= 1.0 + shimmer * (1.0 + 2.0 * smoothstep(0.0, 0.6, total(haze)));

  // Light gathers on the crest of a ring; the front of a switch drags a wash.
  under *= 1.0 + crest * 11.0;
  under *= 1.0 - 0.3 * front;

  // Soft shadow cast down and to the right, as if the ink hangs above the
  // backdrop and the light comes from the upper left.
  vec2 fall = vec2(-0.013 / uAspect, 0.019);
  float shade = total(texture(uWide, uv + fall)) * 0.65 + total(texture(uHaze, uv + fall * 0.55)) * 0.35;
  shade = 1.0 - exp(-1.6 * shade);
  under *= 1.0 - shade * vec3(0.14, 0.13, 0.105);

  // --- Pigment --------------------------------------------------------------
  // Pull filaments forward against their own blur, then let the pigment
  // settle unevenly into the tooth of the paper.
  vec2 dye = max(pigment.rg + 0.25 * (pigment.rg - haze.rg), 0.0);
  float grainy = 1.0 + (tooth - 0.5) * mix(0.4, 0.22, videoMix);
  dye *= grainy;
  // A dilute veil around every stroke.
  dye += wide.rg * 0.10 + haze.rg * 0.06;

  vec3 depth = uAbsorbA * dye.r + uAbsorbB * dye.g;
  vec3 through = exp(-depth);

  // Thick pigment also covers what is behind it with its own colour, so
  // light inks still read over dark parts of the picture.
  vec2 cover = uCover * (1.0 - exp(-2.2 * dye));
  float opacity = 1.0 - (1.0 - cover.x) * (1.0 - cover.y);
  vec3 body = (uBodyA * cover.x + uBodyB * cover.y) / (cover.x + cover.y + 1e-5);

  vec3 color = mix(under * through, body, opacity);

  // Metallic pigment: tiny flakes that catch the light as they turn.
  if (uSheenB > 0.0) {
    vec2 cell = floor(gl_FragCoord.xy / 2.0);
    float flake = hash(cell);
    float turn = fract(flake * 7.0 + uTime * (0.35 + flake) + dot(slope, vec2(3.0)));
    float glint = smoothstep(0.93, 1.0, flake) * smoothstep(0.75, 1.0, turn);
    float gilt = 1.0 - exp(-2.5 * dye.g);
    color += uSheenB * glint * gilt * vec3(1.0, 0.86, 0.55);
    // Broad soft sheen facing the light.
    float facing = clamp(dot(normalize(vec3(-slope * 6.0, 1.0)), normalize(vec3(-0.5, 0.6, 0.62))), 0.0, 1.0);
    color += uSheenB * 0.25 * gilt * pow(facing, 12.0) * vec3(1.0, 0.86, 0.55);
  }

  // --- Lens -----------------------------------------------------------------
  vec2 centred = (uv - 0.5) * vec2(uAspect * 1.5, 1.0) * 2.0;
  float vignette = smoothstep(1.45, 0.45, length(centred));
  color *= mix(mix(vec3(0.80, 0.77, 0.72), vec3(0.80, 0.80, 0.82), videoMix), vec3(1.0), vignette);

  vec3 display = toDisplay(color);

  // --- Tracking marks -------------------------------------------------------
  vec4 marks = texture(uOverlay, vUv) * uOverlayOn;
  if (uOverlayMasked < 0.5) {
    // Colour overlay: drawn as is, with a soft glow from a blurred copy.
    vec3 glow = textureLod(uOverlay, vUv, 3.2).rgb * uOverlayOn;
    display += glow * 0.55 * (1.0 - marks.a);
    display = display * (1.0 - marks.a) + marks.rgb;
  } else if (marks.a > 0.0) {
    // Quiet overlay: the texture holds masks. r = neutral mark, g and b =
    // marks in the first and second pigment, leftover alpha = dark edge.
    // On paper, marks are dark where the sheet is light and light over thick
    // ink, judged from a heavily blurred picture so the choice is steady.
    vec2 unbent = vUv * uVideoFit.xy + uVideoFit.zw;
    float behind = mix(luma(paper), luma(grade(textureLod(uVideo, unbent, 5.0).rgb)), videoMix);
    behind *= luma(exp(-(uAbsorbA * wide.r + uAbsorbB * wide.g)));
    // Over the camera picture the marks stay bright, with a dark edge.
    float lightBehind = smoothstep(0.50, 0.56, pow(behind, 1.0 / 2.2)) * (1.0 - videoMix);
    vec3 darkMark = vec3(0.07, 0.065, 0.06);
    vec3 lightMark = vec3(1.0, 0.99, 0.97);
    vec3 mark = mix(lightMark, darkMark, lightBehind);
    vec3 halo = mix(darkMark, lightMark, lightBehind);
    float haloCover = max(marks.a - marks.r - marks.g - marks.b, 0.0);
    display = display * (1.0 - marks.a)
        + mark * marks.r
        + toDisplay(uBodyA) * marks.g
        + toDisplay(uBodyB) * marks.b
        + halo * haloCover;
  }

  float grain = hash(gl_FragCoord.xy + vec2(uFrame * 37.0, uFrame * 91.0)) - 0.5;
  float grainSoft = hash(floor(gl_FragCoord.xy / 2.0) + vec2(uFrame * 13.0, 7.0)) - 0.5;
  display += (grain * 0.6 + grainSoft * 0.4) * mix(0.030, 0.026, videoMix) * (1.0 - 0.5 * luma(display));
  outColor = vec4(display, 1.0);
}`;
