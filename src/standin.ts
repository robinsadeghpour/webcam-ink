// A soft, out-of-focus stand-in for the camera picture, used in demo mode:
// a figure in a room with window light, painted with a few blurred shapes.

type Ctx = CanvasRenderingContext2D;

function ellipse(ctx: Ctx, x: number, y: number, rx: number, ry: number, color: string, tilt = 0): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, tilt, 0, Math.PI * 2);
  ctx.fill();
}

/** Blurs `source` into a new canvas of the given size. */
function defocus(source: HTMLCanvasElement, w: number, h: number, radius: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (typeof (ctx as { filter?: unknown }).filter === 'string') {
    ctx.filter = `blur(${radius}px)`;
    // Overdraw the edges so the blur does not fade to transparent there.
    const pad = radius * 3;
    ctx.drawImage(source, -pad, -pad, w + pad * 2, h + pad * 2);
    return out;
  }
  // No canvas filters: shrink and enlarge in steps instead.
  let current = source;
  for (const scale of [0.5, 0.25, 0.125]) {
    const step = document.createElement('canvas');
    step.width = Math.max(1, Math.round(source.width * scale));
    step.height = Math.max(1, Math.round(source.height * scale));
    const sctx = step.getContext('2d')!;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(current, 0, 0, step.width, step.height);
    current = step;
  }
  ctx.drawImage(current, 0, 0, w, h);
  return out;
}

export function paintStandIn(): HTMLCanvasElement {
  // A landscape frame, like a webcam's: the figure in the middle of a room.
  const w = 480;
  const h = 270;
  const sketch = document.createElement('canvas');
  sketch.width = w;
  sketch.height = h;
  const ctx = sketch.getContext('2d')!;

  // Wall, lit from a window on the left.
  const wall = ctx.createLinearGradient(0, 0, w, h);
  wall.addColorStop(0, '#d2c9b9');
  wall.addColorStop(0.5, '#a9a195');
  wall.addColorStop(1, '#6e6a67');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(40, 60, 0, 40, 60, 230);
  glow.addColorStop(0, 'rgba(246, 234, 210, 0.75)');
  glow.addColorStop(1, 'rgba(246, 234, 210, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // Far behind: a door frame, something leafy, a shelf, a lamp-lit corner.
  ctx.fillStyle = 'rgba(70, 64, 60, 0.5)';
  ctx.fillRect(388, 0, 34, h);
  ellipse(ctx, 352, 120, 26, 46, 'rgba(58, 72, 58, 0.8)');
  ellipse(ctx, 338, 86, 14, 22, 'rgba(74, 90, 70, 0.7)', 0.5);
  ctx.fillStyle = 'rgba(96, 84, 74, 0.5)';
  ctx.fillRect(40, 150, 96, 8);
  ellipse(ctx, 70, 132, 16, 20, 'rgba(126, 108, 92, 0.6)');
  ellipse(ctx, 110, 138, 9, 14, 'rgba(150, 132, 112, 0.6)');
  ellipse(ctx, 446, 196, 26, 16, 'rgba(214, 170, 110, 0.5)');

  // Shoulders, neck, hair, then the face over it.
  ellipse(ctx, 240, 318, 118, 96, '#353d48');
  ellipse(ctx, 200, 236, 36, 14, 'rgba(92, 102, 116, 0.55)', -0.35);
  ellipse(ctx, 240, 196, 19, 34, '#a07e6b');
  ellipse(ctx, 240, 122, 41, 47, '#2b2421');
  ellipse(ctx, 240, 143, 33, 43, '#c2a08a');
  ellipse(ctx, 254, 149, 20, 35, 'rgba(150, 112, 94, 0.45)');
  ellipse(ctx, 224, 137, 14, 23, 'rgba(226, 196, 172, 0.45)');
  ellipse(ctx, 240, 102, 35, 17, '#2b2421', 0.08);

  return defocus(sketch, 960, 540, 9);
}
