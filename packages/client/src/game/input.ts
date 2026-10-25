import { clamp, PITCH_TYPES } from '@vaseball/core';
import type { PitchType, Vec2 } from '@vaseball/core';

const KEY_SPEED = 2.4; // zone units per second
const AIM_LIMIT = 2.2;

export interface AimBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export const BATTING_BOUNDS: AimBounds = { minX: -AIM_LIMIT, maxX: AIM_LIMIT, minY: -AIM_LIMIT, maxY: AIM_LIMIT };

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

/** Keys that work even while the field is not taking aim input (e.g. requests during a play). */
export type Command = 'request' | 'time' | 'mute';
const COMMAND_KEYS: Record<string, Command> = { KeyR: 'request', KeyT: 'time', KeyM: 'mute' };

/** Mouse / touch / keyboard state shared by the human pitcher and batter. */
export class InputState {
  aim: Vec2 = { x: 0, y: 0 };
  pitchType: PitchType = 'fastball';
  enabled = false;
  /** B is held: the batter squares around to bunt. */
  buntHeld = false;
  onAction: ((now: number) => void) | null = null;
  onCommand: ((command: Command) => void) | null = null;
  private bounds: AimBounds = BATTING_BOUNDS;
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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const command = COMMAND_KEYS[e.code];
      if (command) {
        if (!e.repeat) this.onCommand?.(command);
        return;
      }
      if (!this.enabled) return;
      if (e.code in MOVE_KEYS) {
        this.keys.add(e.code);
        e.preventDefault();
      } else if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        if (!e.repeat) this.onAction?.(performance.now());
      } else if (e.code === 'KeyB') {
        this.buntHeld = true;
      } else if (/^Digit[1-9]$/.test(e.code)) {
        const type = PITCH_TYPES[Number(e.code.slice(5)) - 1];
        if (type) this.pitchType = type;
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyB') this.buntHeld = false;
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.buntHeld = false;
    });
  }

  /** Pitchers can aim further inside and up (at the batter); batters are kept around the zone. */
  setBounds(bounds: AimBounds): void {
    if (bounds === this.bounds) return;
    this.bounds = bounds;
    this.setAim(this.aim);
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
    const b = this.bounds;
    this.aim = { x: clamp(v.x, b.minX, b.maxX), y: clamp(v.y, b.minY, b.maxY) };
  }
}
