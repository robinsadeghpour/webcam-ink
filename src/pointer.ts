// Mouse and touch fallback: the pointer behaves like a single fingertip.
// Moving draws, a click or tap without movement releases a drop, and Shift
// (or a second finger) uses the other pigment.

import { Brush } from './brush';

export function attachPointer(stage: HTMLElement, brush: Brush, now: () => number): void {
  const downAt = new Map<number, { x: number; y: number; moved: boolean }>();
  const touchPigment = new Map<number, 0 | 1>();

  const locate = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const inside = (p: { x: number; y: number }) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;

  const pigmentFor = (e: PointerEvent): 0 | 1 => {
    if (e.pointerType !== 'touch') return e.shiftKey || e.buttons === 2 ? 1 : 0;
    let p = touchPigment.get(e.pointerId);
    if (p === undefined) {
      p = touchPigment.size % 2 === 0 ? 0 : 1;
      touchPigment.set(e.pointerId, p);
    }
    return p;
  };

  window.addEventListener('pointermove', (e) => {
    const p = locate(e);
    const id = `pointer-${e.pointerId}`;
    if (!inside(p)) {
      brush.lift(id);
      return;
    }
    const press = downAt.get(e.pointerId);
    if (press && Math.hypot(p.x - press.x, p.y - press.y) > 0.012) press.moved = true;
    brush.point(id, p.x, p.y, now(), 'ink', pigmentFor(e));
  });

  window.addEventListener('pointerdown', (e) => {
    const p = locate(e);
    if (!inside(p)) return;
    downAt.set(e.pointerId, { ...p, moved: false });
    if (e.pointerType === 'touch') brush.point(`pointer-${e.pointerId}`, p.x, p.y, now(), 'ink', pigmentFor(e));
  });

  const release = (e: PointerEvent) => {
    const press = downAt.get(e.pointerId);
    downAt.delete(e.pointerId);
    if (press && !press.moved) brush.drop(press.x, press.y, pigmentFor(e));
    if (e.pointerType === 'touch') {
      brush.lift(`pointer-${e.pointerId}`);
      touchPigment.delete(e.pointerId);
    }
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  document.addEventListener('pointerleave', (e) => brush.lift(`pointer-${e.pointerId}`));
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
}
