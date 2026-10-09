// Webcam hand tracking with MediaPipe, reduced to what the brush and the
// overlay need: where the hand is on the stage and what it is doing.

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

// The tracker's runtime and model are shipped with the site (see
// tools/copy-assets.mjs), so nothing is fetched from anywhere else.
const MODEL = 'mediapipe/hand_landmarker.task';

// Landmark indices: wrist, then four joints per finger from thumb to little finger.
export const WRIST = 0;
export const FINGERS = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
] as const;

// 'snap' is a hand held ready to snap: thumb pressed against the middle finger.
export type Gesture = 'point' | 'open' | 'pinch' | 'snap' | 'rest';

export interface Point {
  x: number;
  y: number;
}

export interface Point3 extends Point {
  z: number;
}

export interface HandState {
  /** 0 or 1; stable for as long as the hand stays in view. */
  slot: 0 | 1;
  gesture: Gesture;
  /** True on the single frame a pinch closes. */
  pinched: boolean;
  /** True for as long as thumb and index stay together. */
  pinching: boolean;
  /** Which of the person's hands this is, and how sure the tracker is (0..1). */
  side: 'left' | 'right' | null;
  score: number | null;
  /** All 21 landmarks in stage coordinates (x, y in 0..1, y down). */
  points: Point[];
  /** Fingertips in stage coordinates, thumb first. */
  tips: Point[];
  /** Which of the five fingers are held straight. */
  extended: boolean[];
  palm: Point;
  /** Wrist to middle knuckle, in stage heights: the hand's own yardstick. */
  size: number;
  pinchPoint: Point;
  /** Thumb-to-index distance in hand sizes: about 0.2 when touching. */
  pinchGap: number;
  /** Thumb-to-middle-finger distance in hand sizes, and the point between them. */
  snapGap: number;
  snapPoint: Point;
  /** True while the thumb is pressed to the middle finger, ready to snap. */
  snapReady: boolean;
  /** How straight the middle finger is: 1 = straight, about 0.3 = folded into the palm. */
  middleStraight: number;
}

export interface HandMemory {
  /** Tracking results in a row that have included this hand. */
  seen: number;
  /** Results in a row in which thumb and index were together. */
  pinchFrames: number;
  /** Thumb-to-index gap in the previous result. */
  lastGap: number;
  extended: boolean[];
  pinching: boolean;
  gesture: Gesture;
  pending: Gesture;
  pendingFrames: number;
}

export function newHandMemory(): HandMemory {
  return {
    seen: 0,
    pinchFrames: 0,
    lastGap: 9,
    extended: [false, false, false, false, false],
    pinching: false,
    gesture: 'rest',
    pending: 'rest',
    pendingFrames: 0,
  };
}

function dist3(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Ratio of a finger's end-to-end length to the sum of its bones: 1 = straight. */
function straightness(points: Point3[], joints: readonly number[]): number {
  const [a, b, c, d] = joints.map((i) => points[i]);
  const bones = dist3(a, b) + dist3(b, c) + dist3(c, d);
  return bones > 0 ? dist3(a, d) / bones : 0;
}

/**
 * Reads a gesture out of one hand's landmarks.
 * `stage` holds the landmarks as they appear on the stage; `shape` holds the
 * same joints in any undistorted space (metres from the tracker, or the
 * stage points themselves) and is only used to judge how straight fingers are.
 */
export function interpret(
  slot: 0 | 1,
  stage: Point[],
  shape: Point3[],
  stageAspect: number,
  mem: HandMemory,
  side: 'left' | 'right' | null = null,
  score: number | null = null,
): HandState {
  // Straight fingers, with a little hysteresis so they do not flicker.
  const extended = FINGERS.map((joints, f) => {
    const s = straightness(shape, joints);
    const was = mem.extended[f];
    const limit = f === 0 ? (was ? 0.86 : 0.92) : was ? 0.8 : 0.88;
    const awayFromPalm = dist3(shape[joints[3]], shape[WRIST]) > dist3(shape[joints[1]], shape[WRIST]);
    return s > limit && (f === 0 || awayFromPalm);
  });
  mem.extended = extended;

  const tips = FINGERS.map((joints) => stage[joints[3]]);
  const wrist = stage[WRIST];
  const knuckle = stage[9];
  const span = (a: Point, b: Point) => Math.hypot((a.x - b.x) * stageAspect, a.y - b.y);
  const size = Math.max(span(wrist, knuckle), span(stage[5], stage[17]) * 1.2, 1e-4);

  // Pinch: thumb and index tips together, relative to the size of the hand.
  // In a fist the two tips also sit together, so the index finger has to be
  // reaching out from its knuckle for it to count.
  const pinchGap = span(tips[0], tips[1]) / size;
  const reach = dist3(shape[8], shape[5]) / Math.max(dist3(shape[WRIST], shape[9]), 1e-6);
  // A pinch has to show in two results running, on a hand that has been in
  // view for a moment, and the gap has to have been closing rather than
  // jumping shut, so a flicker of tracking cannot let a drop go.
  mem.seen++;
  const wasPinching = mem.pinching;
  const closing = mem.pinchFrames > 0 || mem.lastGap < 0.75;
  // Thumb against the middle finger is the start of a snap, not a pinch:
  // the index has to be the finger nearest the thumb.
  const snapGap = span(tips[0], tips[2]) / size;
  // The middle finger must be reaching for the thumb, not curled into a
  // fist under it, which is how a pointing hand looks.
  const middleStraight = straightness(shape, FINGERS[2]);
  const snapReady = snapGap < 0.3 && snapGap + 0.05 < pinchGap && middleStraight > 0.45;
  const together =
    reach > 0.4 &&
    closing &&
    pinchGap <= snapGap + 0.03 &&
    (mem.pinchFrames > 0 ? pinchGap < 0.42 : pinchGap < 0.24);
  mem.pinchFrames = together ? mem.pinchFrames + 1 : 0;
  mem.lastGap = pinchGap;
  mem.pinching = together && (wasPinching || (mem.pinchFrames >= 2 && mem.seen > 3));
  const pinched = mem.pinching && !wasPinching;

  const straightFingers = extended.slice(1).filter(Boolean).length;
  let want: Gesture = 'rest';
  if (mem.pinching) want = 'pinch';
  else if (snapReady) want = 'snap';
  else if (straightFingers === 4 && extended[0]) want = 'open';
  else if (straightFingers > 0) want = 'point';

  // A gesture has to hold for a few frames before it takes over, except a
  // pinch, which should feel instant.
  if (want === mem.gesture) {
    mem.pendingFrames = 0;
  } else if (want === 'pinch') {
    mem.gesture = want;
    mem.pendingFrames = 0;
  } else {
    if (want !== mem.pending) {
      mem.pending = want;
      mem.pendingFrames = 0;
    }
    if (++mem.pendingFrames >= 3) mem.gesture = want;
  }

  return {
    slot,
    gesture: mem.gesture,
    pinched,
    pinching: mem.pinching,
    side,
    score,
    points: stage,
    tips,
    extended,
    palm: { x: (wrist.x + knuckle.x) / 2, y: (wrist.y + knuckle.y) / 2 },
    size,
    pinchPoint: { x: (tips[0].x + tips[1].x) / 2, y: (tips[0].y + tips[1].y) / 2 },
    pinchGap,
    snapGap,
    snapPoint: { x: (tips[0].x + tips[2].x) / 2, y: (tips[0].y + tips[2].y) / 2 },
    snapReady,
    middleStraight,
  };
}

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private lastVideoTime = -1;
  private readonly memory: HandMemory[] = [newHandMemory(), newHandMemory()];

  /** Milliseconds the most recent detection took. */
  lastCost = 0;

  get ready(): boolean {
    return this.landmarker !== null;
  }

  async load(): Promise<void> {
    const base = new URL('.', document.baseURI).href;
    const files = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
    // Prefer the GPU, then fall back to the CPU.
    let lastError: unknown;
    for (const delegate of ['GPU', 'CPU'] as const) {
      try {
        this.landmarker = await HandLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: `${base}${MODEL}`, delegate },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  /** A hand that has left the picture starts from scratch when it returns. */
  private forget(slots: readonly number[]): void {
    for (const slot of slots) {
      const mem = this.memory[slot];
      mem.seen = 0;
      mem.pinchFrames = 0;
      mem.lastGap = 9;
      mem.pinching = false;
    }
  }

  /**
   * Runs detection if the video has a new frame. Returns null when there is
   * nothing new, otherwise the hands currently in view (possibly none).
   */
  detect(video: HTMLVideoElement, stageAspect: number, nowMs: number): HandState[] | null {
    if (!this.landmarker || video.readyState < 2 || !video.videoWidth) return null;
    if (video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;

    const began = performance.now();
    const result = this.landmarker.detectForVideo(video, nowMs);
    this.lastCost = performance.now() - began;
    const count = Math.min(result.landmarks.length, 2);
    if (count === 0) {
      this.forget([0, 1]);
      return [];
    }

    // How the video is cropped to cover the stage (mirrored horizontally).
    const videoAspect = video.videoWidth / video.videoHeight;
    let sx = 1;
    let sy = 1;
    if (videoAspect > stageAspect) sx = stageAspect / videoAspect;
    else sy = videoAspect / stageAspect;
    const toStage = (p: NormalizedLandmark): Point => ({
      x: 1 - ((p.x - 0.5) / sx + 0.5),
      y: (p.y - 0.5) / sy + 0.5,
    });
    const stagePoints = result.landmarks.slice(0, count).map((hand) => hand.map(toStage));

    // One slot per hand: by handedness, or by side if both report the same.
    // The tracker names hands as if it were looking at a mirror image. It is
    // given the unmirrored camera frame, so its "Left" is the person's right.
    const slots: (0 | 1)[] = [];
    const sides: ('left' | 'right')[] = [];
    const scores: number[] = [];
    for (let i = 0; i < count; i++) {
      const guess = result.handedness[i]?.[0];
      const label = guess?.categoryName ?? 'Left';
      slots.push(label === 'Left' ? 0 : 1);
      sides.push(label === 'Left' ? 'right' : 'left');
      scores.push(guess?.score ?? 0);
    }
    if (count === 2 && slots[0] === slots[1]) {
      const leftmost = stagePoints[0][WRIST].x < stagePoints[1][WRIST].x ? 0 : 1;
      slots[leftmost] = 0;
      slots[1 - leftmost] = 1;
    }

    this.forget(([0, 1] as const).filter((slot) => !slots.includes(slot)));
    const hands: HandState[] = [];
    for (let i = 0; i < count; i++) {
      const shape = result.worldLandmarks[i] ?? result.landmarks[i];
      hands.push(interpret(slots[i], stagePoints[i], shape, stageAspect, this.memory[slots[i]], sides[i], scores[i]));
    }
    return hands;
  }
}

/**
 * Asks for the front camera, and for the microphone with it, and resolves
 * once frames are flowing. If the microphone is refused the camera is asked
 * for on its own; the returned stream then has no audio track.
 */
export async function openCamera(withSound = true): Promise<{ video: HTMLVideoElement; stream: MediaStream }> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera access.');
  // Resolution matters more than frame rate here.
  const picture: MediaTrackConstraints = {
    facingMode: 'user',
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
  };
  // Claps and snaps are short transients; the usual voice processing would
  // smooth them away.
  const sound: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: withSound ? sound : false, video: picture });
  } catch (err) {
    if (!withSound) throw err;
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: picture });
  }
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) {
    await new Promise<void>((resolve) => video.addEventListener('loadeddata', () => resolve(), { once: true }));
  }
  return { video, stream };
}
