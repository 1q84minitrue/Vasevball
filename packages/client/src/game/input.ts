import { clamp, PITCH_TYPES } from '@vaseball/core';
import type { PitchType, Vec2 } from '@vaseball/core';

const KEY_SPEED = 2.4; // zone units per second
const AIM_LIMIT = 2.2;

const MOVE_KEYS: Record<string, Vec2> = {
  ArrowLeft: { x: -1, y: 0 },
  KeyA: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  KeyD: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: 1 },
  KeyW: { x: 0, y: 1 },
  ArrowDown: { x: 0, y: -1 },
  KeyS: { x: 0, y: -1 },
};

/** Mouse / touch / keyboard state shared by the human pitcher and batter. */
export class InputState {
  aim: Vec2 = { x: 0, y: 0 };
  pitchType: PitchType = 'fastball';
  enabled = false;
  onAction: ((now: number) => void) | null = null;
  private readonly keys = new Set<string>();

  constructor(canvas: HTMLCanvasElement, toZone: (clientX: number, clientY: number) => Vec2) {
    canvas.addEventListener('pointermove', (e) => {
      if (this.enabled && e.pointerType !== 'touch') this.setAim(toZone(e.clientX, e.clientY));
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.setAim(toZone(e.clientX, e.clientY));
      this.onAction?.(performance.now());
    });
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code in MOVE_KEYS) {
        this.keys.add(e.code);
        e.preventDefault();
      } else if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        if (!e.repeat) this.onAction?.(performance.now());
      } else if (/^Digit[1-9]$/.test(e.code)) {
        const type = PITCH_TYPES[Number(e.code.slice(5)) - 1];
        if (type) this.pitchType = type;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  update(dtSec: number): void {
    let dx = 0;
    let dy = 0;
    for (const code of this.keys) {
      const v = MOVE_KEYS[code];
      if (!v) continue;
      dx += v.x;
      dy += v.y;
    }
    if (dx || dy) this.setAim({ x: this.aim.x + dx * KEY_SPEED * dtSec, y: this.aim.y + dy * KEY_SPEED * dtSec });
  }

  private setAim(v: Vec2): void {
    this.aim = { x: clamp(v.x, -AIM_LIMIT, AIM_LIMIT), y: clamp(v.y, -AIM_LIMIT, AIM_LIMIT) };
  }
}
