import { Ear, Onset } from './audio';
import { Brush } from './brush';
import { Demo } from './demo';
import { Fluid } from './fluid';
import { GestureReader } from './gestures';
import { GL, Screen } from './gl';
import { HandState, HandTracker, openCamera } from './hands';
import { OVERLAY_MODES, Overlay, OverlayMode } from './overlay';
import { PALETTES, Palette, mixPalette } from './palettes';
import { attachPointer } from './pointer';
import { Recorder } from './recorder';
import { paintStandIn } from './standin';
import { Backdrop, View } from './view';

// The picture is always rendered at its design size and scaled by CSS, so
// screenshots and recordings come out the same whatever the window.
const SHAPES = {
  landscape: { w: 1920, h: 1080 },
  portrait: { w: 1080, h: 1920 },
} as const;
type Shape = keyof typeof SHAPES;

// Length of the long side of the simulation grid and of the pigment buffer.
const QUALITY = {
  low: { sim: 320, ink: 960 },
  medium: { sim: 480, ink: 1280 },
  high: { sim: 640, ink: 1920 },
} as const;
type Quality = keyof typeof QUALITY;
const LADDER: Quality[] = ['low', 'medium', 'high'];

const params = new URLSearchParams(location.search);
const demoMode = params.get('demo') === '1';
// With ?manual the clock only moves when a script asks it to (see tools/).
const manual = params.has('manual');

const stage = document.getElementById('stage') as HTMLElement;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const hint = document.getElementById('hint') as HTMLElement;
const whisper = document.getElementById('whisper') as HTMLElement;
const note = document.getElementById('note') as HTMLElement;
const paletteName = document.getElementById('palette-name') as HTMLElement;
const recLight = document.getElementById('rec') as HTMLElement;
const recText = document.getElementById('rec-text') as HTMLElement;

let shape: Shape = params.get('aspect') === 'portrait' ? 'portrait' : 'landscape';
let stageW: number = SHAPES[shape].w;
let stageH: number = SHAPES[shape].h;
let stageAspect = stageW / stageH;
canvas.width = stageW;
canvas.height = stageH;
stage.dataset.aspect = shape;

function fail(message: string): never {
  const el = document.getElementById('failure') as HTMLElement;
  el.textContent = message;
  el.hidden = false;
  throw new Error(message);
}

const context = canvas.getContext('webgl2', {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  powerPreference: 'high-performance',
});
if (!context) fail('This needs WebGL 2, which this browser does not offer.');
const gl: GL = context;
if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
  fail('This needs floating-point render targets, which this device does not offer.');
}

const screen = new Screen(gl);
const view = new View(gl, screen);

function makeFluid(q: Quality): Fluid {
  const { sim, ink } = QUALITY[q];
  const short = Math.min(stageW, stageH) / Math.max(stageW, stageH);
  const size = (long: number): [number, number] =>
    stageW > stageH ? [long, Math.round(long * short)] : [Math.round(long * short), long];
  return new Fluid(gl, screen, ...size(sim), ...size(ink));
}

// Marks are sized in stage heights; a wide stage is short, so it needs
// heavier marks to carry the same weight in the picture.
const markScale = () => (stageW > stageH ? 1.6 : 1);

const coarse = matchMedia('(pointer: coarse)').matches;
const asked = params.get('q') as Quality | null;
let quality: Quality = asked && asked in QUALITY ? asked : coarse ? 'medium' : 'high';
let fluid = makeFluid(quality);
const brush = new Brush(fluid);
brush.scale = markScale();
brush.onDrop = (x, y, power) => view.addRipple(x, y, 0.004 + 0.0025 * power, clock);

// --- Palette and background state -----------------------------------------

let paletteIndex = Math.min(PALETTES.length - 1, Math.max(0, Number(params.get('palette') ?? 0) | 0));
let paletteFrom: Palette = PALETTES[paletteIndex];
let paletteBlend = 1;
let shown: Palette = PALETTES[paletteIndex];

function setPalette(index: number): void {
  const next = ((index % PALETTES.length) + PALETTES.length) % PALETTES.length;
  if (next === paletteIndex) return;
  paletteFrom = shown;
  paletteIndex = next;
  paletteBlend = 0;
  paletteName.textContent = PALETTES[next].name;
}
paletteName.textContent = PALETTES[paletteIndex].name;

let backdrop: Backdrop | null = null;
let backdropIsCamera = false;
let wantCamera = params.get('bg') !== 'paper' && !(demoMode && params.get('bg') !== 'video');

// The background is 0 for paper and 1 for the camera. A switch spreads out
// from a point over about a second rather than cutting or fading.
const WIPE_SECONDS = 1.15;
let bgFrom = 0;
let bgTo = 0;
let wipe: { x: number; y: number; start: number } | null = null;

function switchBackground(camera: boolean, x = 0.5, y = 0.5): void {
  const target = camera && backdrop ? 1 : 0;
  wantCamera = target === 1;
  if (target === bgTo) return;
  bgFrom = bgTo;
  bgTo = target;
  wipe = { x, y, start: clock };
}

// --- Hands ----------------------------------------------------------------------

const tracker = new HandTracker();
const gestures = new GestureReader();
// The microphone hears claps and snaps; sounds wait here for the next
// tracking result, which decides what they were.
const ear = new Ear();
let heard: Onset[] = [];
const overlay = new Overlay();
// Moments the overlay should flash: where and when.
let clapMark: { x: number; y: number; time: number; count: 1 | 2; peak?: number } | null = null;
let snapMark: { x: number; y: number; time: number; peak: number } | null = null;
let unplacedMark: { time: number; peak: number } | null = null;
let twinMark: { x: number; y: number; time: number } | null = null;
let clapping = false;
const askedOverlay = params.get('overlay') as OverlayMode | null;
let overlayMode: OverlayMode = askedOverlay && OVERLAY_MODES.includes(askedOverlay) ? askedOverlay : 'full';
let trackMs = 0;
let fps = 60;
let overlayDt = 0;
// Distance between the two hands, in stage heights, and the stroke width it
// sets: hands apart draw broad strokes, hands together draw fine ones.
let span: { distance: number; width: number } | null = null;

function applyHands(hands: HandState[], time: number, sounds: Onset[] | null): void {
  // Claps first: hands that are clapping must not draw, drop or stir on
  // their way in, and must not change the stroke width.
  const events = gestures.update(hands, time, stageAspect, sounds);
  clapping = events.busy;

  const seen = [false, false];
  for (const hand of hands) {
    seen[hand.slot] = true;
    const prefix = `hand${hand.slot}-`;

    if (events.busy) {
      brush.liftAll(prefix);
    } else if (hand.gesture === 'point') {
      brush.lift(`${prefix}0`);
      brush.lift(`${prefix}palm`);
      for (let f = 1; f < 5; f++) {
        const tip = hand.tips[f];
        if (hand.extended[f]) brush.point(`${prefix}${f}`, tip.x, tip.y, time, 'ink', hand.slot);
        else brush.lift(`${prefix}${f}`);
      }
    } else if (hand.gesture === 'open') {
      for (let f = 0; f < 5; f++) {
        brush.point(`${prefix}${f}`, hand.tips[f].x, hand.tips[f].y, time, 'stir', hand.slot);
      }
      brush.point(`${prefix}palm`, hand.palm.x, hand.palm.y, time, 'stir', hand.slot);
    } else {
      brush.liftAll(prefix);
    }
  }
  for (const slot of [0, 1]) if (!seen[slot]) brush.liftAll(`hand${slot}-`);

  if (hands.length === 2 && !events.busy) {
    const [a, b] = hands;
    const distance = Math.hypot((a.palm.x - b.palm.x) * stageAspect, a.palm.y - b.palm.y);
    const t = Math.min(1, Math.max(0, (distance - 0.3) / 1.0));
    const width = 0.8 + 0.6 * t * t * (3 - 2 * t);
    span = { distance, width: span ? span.width + (width - span.width) * 0.15 : width };
  } else if (hands.length < 2) {
    span = null;
  }
  if (!events.busy) brush.widthGain += ((span ? span.width : 1) - brush.widthGain) * 0.15;

  // Pinches, held pinches and two pinches at once. The two drops of a
  // double pinch fall a little lighter, since the burst adds to them.
  for (const drop of events.drops) brush.drop(drop.x, drop.y, drop.slot, events.twin ? drop.power * 0.6 : drop.power);
  if (events.twin) {
    brush.burst(events.twin.x, events.twin.y);
    view.addRipple(events.twin.x, events.twin.y, 0.011, clock);
    twinMark = { ...events.twin, time: clock };
  }
  // A snap switches the background, from the snapping fingers outward.
  if (events.snap) {
    switchBackground(bgTo !== 1, events.snap.x, events.snap.y);
    view.addRipple(events.snap.x, events.snap.y, 0.009, clock);
    snapMark = { x: events.snap.x, y: events.snap.y, time: clock, peak: events.snap.peak };
  }
  // One clap is only a promise. The second switches the background, from
  // where the hands met, the same as a snap.
  if (events.clap) {
    clapMark = { x: events.clap.x, y: events.clap.y, time: clock, count: events.clap.count, peak: events.clap.peak };
    if (events.clap.count === 2) {
      switchBackground(bgTo !== 1, events.clap.x, events.clap.y);
      view.addRipple(events.clap.x, events.clap.y, 0.012, clock);
    } else {
      view.addRipple(events.clap.x, events.clap.y, 0.004, clock);
    }
  }
  if (events.unplaced) unplacedMark = { time: clock, peak: events.unplaced.peak };
}

async function startCamera(): Promise<void> {
  try {
    const { video, stream } = await openCamera(params.get('mic') !== 'off');
    ear.start(stream);
    backdrop = video;
    backdropIsCamera = true;
    if (wantCamera) switchBackground(true);
  } catch {
    wantCamera = false;
    note.textContent = 'The camera is off, so this is paper only. Move the pointer to draw, click for a drop, hold Shift for the second ink.';
    return;
  }
  try {
    await tracker.load();
  } catch (err) {
    console.warn('Hand tracking could not start.', err);
    note.textContent = 'Hand tracking could not start. Move the pointer to draw, click for a drop, hold Shift for the second ink.';
  }
}

// --- Frame loop ---------------------------------------------------------------

let clock = 0;
// ?idle keeps the demo backdrop but leaves the water alone, for scripted input.
const demo = demoMode && !params.has('idle') ? new Demo(() => fluid.clear()) : null;
if (demo) demo.stageAspect = stageAspect;

function advance(dt: number): void {
  clock += dt;
  let hands: HandState[] | null = null;
  if (demo) {
    hands = demo.update(clock);
    applyHands(hands, clock, demo.sounds());
  } else if (backdropIsCamera && tracker.ready) {
    const now = performance.now() / 1000;
    heard.push(...ear.poll(now));
    hands = tracker.detect(backdrop as HTMLVideoElement, stageAspect, performance.now());
    if (hands) {
      applyHands(hands, now, ear.present ? heard : null);
      heard = [];
      trackMs += (tracker.lastCost - trackMs) * 0.1;
    }
  }
  overlay.update(hands);
  overlayDt += dt;
  // A held pinch gathers pigment until it is let go.
  for (const slot of [0, 1] as const) {
    const held = gestures.held(slot);
    if (held && held.charge > 0) brush.gather(held.x, held.y, slot, held.charge, dt);
  }
  brush.update(dt);
  fluid.step(dt);

  if (wipe && clock - wipe.start >= WIPE_SECONDS) {
    wipe = null;
    bgFrom = bgTo;
  }

  if (paletteBlend < 1) {
    paletteBlend = Math.min(1, paletteBlend + dt / 0.9);
    const t = paletteBlend * paletteBlend * (3 - 2 * paletteBlend);
    shown = mixPalette(paletteFrom, PALETTES[paletteIndex], t);
  } else {
    shown = PALETTES[paletteIndex];
  }
}

/** What the tracking line of the overlay should say right now. */
function trackLabel(): string {
  if (demo) return 'SYNTHETIC';
  if (!backdropIsCamera) return demoMode ? 'OFF' : 'NO CAMERA';
  return tracker.ready ? `${trackMs.toFixed(1)} MS` : 'LOADING';
}

function render(): void {
  if (backdrop && backdropIsCamera && (bgFrom > 0 || bgTo > 0)) view.setBackdrop(backdrop, true, stageAspect);

  // While recording a reel frame the picture ends up 1080 wide, so the
  // overlay is drawn as for a display that small: larger type, heavier lines.
  const shownScale = (stage.getBoundingClientRect().height * (window.devicePixelRatio || 1)) / stageH;
  const pixelScale = recorder.active && recordingReel ? Math.min(shownScale, reel.width / stageW) : shownScale;
  const drawn = overlay.draw(overlayMode, pixelScale, overlayDt, {
    track: trackLabel(),
    fps,
    background: bgTo === 1 ? 'CAMERA' : 'PAPER',
    palette: PALETTES[paletteIndex],
    tip: (slot, finger) => brush.motion(`hand${slot}-${finger}`),
    handLevel: (slot) => brush.levelOf(`hand${slot}-`),
    pointers: brush
      .ids('pointer-')
      .map((id) => brush.motion(id))
      .filter((m) => m !== null),
    span,
    held: (slot) => gestures.held(slot),
    clap: clapMark
      ? {
          x: clapMark.x,
          y: clapMark.y,
          age: clock - clapMark.time,
          count: clapMark.count,
          windowLeft: gestures.clapWindow(demo ? clock : performance.now() / 1000),
          peak: clapMark.peak,
        }
      : null,
    snap: snapMark ? { x: snapMark.x, y: snapMark.y, age: clock - snapMark.time, peak: snapMark.peak } : null,
    unplaced: unplacedMark ? { age: clock - unplacedMark.time, peak: unplacedMark.peak } : null,
    mic: demo
      ? { label: 'SYNTHETIC', level: null, threshold: null }
      : !ear.present
        ? { label: backdropIsCamera ? 'OFF \u00b7 CAMERA ONLY' : 'OFF', level: null, threshold: null }
        : !ear.listening
          ? { label: 'PRESS ANY KEY', level: null, threshold: null }
          : { label: '', level: ear.levelDb, threshold: ear.thresholdDb },
    clapping,
    twin: twinMark ? { x: twinMark.x, y: twinMark.y, age: clock - twinMark.time } : null,
  });
  overlayDt = 0;
  view.setOverlay(drawn ? overlay.canvas : null, overlayMode === 'mono');

  // A switch reaches the farthest corner by the time it ends, easing out.
  let spread: { x: number; y: number; radius: number } | null = null;
  if (wipe) {
    const t = Math.min(1, (clock - wipe.start) / WIPE_SECONDS);
    const far = Math.hypot(Math.max(wipe.x, 1 - wipe.x) * stageAspect, Math.max(wipe.y, 1 - wipe.y)) + 0.25;
    spread = { x: wipe.x, y: wipe.y, radius: far * (1 - (1 - t) * (1 - t)) };
  }
  view.draw(fluid, shown, { from: bgFrom, to: bgTo, wipe: spread }, clock, stageW, stageH);
  if (recorder.active) {
    if (recordingReel) paintReel();
    recText.textContent = `${recordingReel ? 'REEL ' : ''}${clockText(recorder.seconds)}`;
  }
}

/** Switches between the landscape and the portrait stage. */
function setShape(next: Shape): void {
  if (next === shape || recorder.active) return;
  shape = next;
  stageW = SHAPES[shape].w;
  stageH = SHAPES[shape].h;
  stageAspect = stageW / stageH;
  canvas.width = stageW;
  canvas.height = stageH;
  stage.dataset.aspect = shape;
  fluid.dispose();
  fluid = makeFluid(quality);
  brush.fluid = fluid;
  brush.scale = markScale();
  overlay.resize(stageW, stageH);
  if (demo) demo.stageAspect = stageAspect;
  if (backdrop && !backdropIsCamera) view.setBackdrop(backdrop, false, stageAspect);
}

// If the first seconds run slowly, step down to a lighter grid once or twice.
// The median is used so that one long hitch (the hand model compiling, say)
// does not count against the device.
let samples: number[] | null = asked || demoMode ? null : [];
let warmup = 40;
function watchSpeed(elapsed: number): void {
  if (!samples) return;
  if (warmup > 0) {
    warmup--;
    return;
  }
  samples.push(elapsed);
  if (samples.length < 120) return;
  const median = samples.sort((a, b) => a - b)[60];
  const rung = LADDER.indexOf(quality);
  if (median > 0.024 && rung > 0) {
    quality = LADDER[rung - 1];
    fluid.dispose();
    fluid = makeFluid(quality);
    brush.fluid = fluid;
    samples = [];
    warmup = 40;
  } else {
    samples = null;
  }
}

let last = performance.now();
function frame(now: number): void {
  const elapsed = (now - last) / 1000;
  last = now;
  if (!manual) {
    advance(Math.min(1 / 30, Math.max(1 / 240, elapsed)));
    if (elapsed > 0) fps += (Math.min(240, 1 / elapsed) - fps) * 0.05;
    if (document.visibilityState === 'visible') watchSpeed(elapsed);
  }
  render();
  requestAnimationFrame(frame);
}

// --- Controls -------------------------------------------------------------------

function clockText(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

// The light and its text sit above the canvas in the page, so they are
// never part of the recorded picture.
let recNoteTimer = 0;
function recNote(text: string, recording: boolean, lingerMs = 0): void {
  window.clearTimeout(recNoteTimer);
  recText.textContent = text;
  recLight.classList.toggle('live', recording);
  recLight.hidden = false;
  if (lingerMs) recNoteTimer = window.setTimeout(() => (recLight.hidden = true), lingerMs);
}

// The "reel frame": a 1080 x 1920 picture with the stage centred on near
// black, the way a landscape webcam clip sits inside a vertical reel.
const reel = document.createElement('canvas');
reel.width = 1080;
reel.height = 1920;
const reelCtx = reel.getContext('2d', { alpha: false })!;
let recordingReel = false;

function paintReel(): void {
  const h = Math.round((reel.width * stageH) / stageW);
  reelCtx.fillStyle = '#0b0b0c';
  reelCtx.fillRect(0, 0, reel.width, reel.height);
  reelCtx.imageSmoothingEnabled = true;
  reelCtx.imageSmoothingQuality = 'high';
  reelCtx.drawImage(canvas, 0, Math.round((reel.height - h) / 2), reel.width, h);
}

function toggleRecording(asReel: boolean): void {
  if (!recorder.active) {
    recordingReel = asReel;
    if (asReel) paintReel();
  }
  recorder.toggle(recordingReel ? reel : canvas, recordingReel ? 'reel' : '');
}

const recorder = new Recorder({
  started: () => recNote('0:00', true),
  saved: (fileName, label) => recNote(`Saved ${fileName} \u00b7 ${label}`, false, 4000),
  failed: (reason) => recNote(reason, false, 5000),
});

function toggleHint(force?: boolean): void {
  hint.hidden = force === undefined ? !hint.hidden : !force;
  whisper.hidden = true;
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === 'p') setPalette(paletteIndex + (e.shiftKey ? -1 : 1));
  else if (key >= '1' && key <= String(PALETTES.length)) setPalette(Number(key) - 1);
  else if (key === 'b') switchBackground(bgTo !== 1);
  else if (key === 'c') fluid.clear();
  else if (key === 't') overlayMode = OVERLAY_MODES[(OVERLAY_MODES.indexOf(overlayMode) + 1) % OVERLAY_MODES.length];
  else if (key === 'r') toggleRecording(e.shiftKey);
  else if (key === 'a') setShape(shape === 'landscape' ? 'portrait' : 'landscape');
  else if (key === 'h' || key === '?') toggleHint();
  else if (key === 'escape') toggleHint(false);
  else if (key === 'f') {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  } else return;
  whisper.hidden = true;
});

attachPointer(stage, brush, () => performance.now() / 1000);

if (demoMode) {
  backdrop = paintStandIn();
  view.setBackdrop(backdrop, false, stageAspect);
  if (wantCamera) bgFrom = bgTo = 1;
  // Hooks for the screenshot scripts in tools/.
  Object.assign(window, {
    ink: {
      advance(frames: number, dt = 1 / 60) {
        for (let i = 0; i < frames; i++) advance(dt);
        fps = 1 / dt;
        render();
        return clock;
      },
      palette: setPalette,
      background: (kind: 'paper' | 'video') => switchBackground(kind === 'video'),
      settle() {
        wipe = null;
        bgFrom = bgTo;
        paletteBlend = 1;
        shown = PALETTES[paletteIndex];
      },
      overlay: (mode: OverlayMode) => (overlayMode = mode),
      shape: setShape,
      fluid: () => fluid,
      brush,
    },
  });
} else {
  void startCamera();
  whisper.hidden = false;
  window.setTimeout(() => (whisper.hidden = true), 5000);
}
if (params.get('hint') === '1') toggleHint(true);

requestAnimationFrame(frame);
