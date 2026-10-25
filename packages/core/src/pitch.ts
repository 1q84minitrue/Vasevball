import type { Rng } from './rng';
import type { Pitch, PitchInput, PitchType, Vec2 } from './types';
import { clamp, lerp } from './util';

export interface PitchSpec {
  label: string;
  speedKmh: number;
  /** Late break in zone units (+x = first-base side, for a right-handed pitcher). */
  brk: Vec2;
  /** Standard deviation of the control error, in zone units. */
  control: number;
}

export const PITCH_SPECS: Record<PitchType, PitchSpec> = {
  fastball: { label: 'ストレート', speedKmh: 153, brk: { x: -0.1, y: 0.15 }, control: 0.16 },
  slider: { label: 'スライダー', speedKmh: 132, brk: { x: 0.9, y: -0.225 }, control: 0.2 },
  curve: { label: 'カーブ', speedKmh: 115, brk: { x: 0.54, y: -1.17 }, control: 0.24 },
  changeup: { label: 'チェンジアップ', speedKmh: 126, brk: { x: -0.405, y: -0.54 }, control: 0.2 },
  fork: { label: 'フォーク', speedKmh: 134, brk: { x: 0.045, y: -1.08 }, control: 0.24 },
  sinker: { label: 'シンカー', speedKmh: 128, brk: { x: -0.72, y: -0.765 }, control: 0.22 },
};

export const PITCH_TYPES = Object.keys(PITCH_SPECS) as PitchType[];

export const PITCH_DISTANCE_M = 18.44;
/** Real pitches are too fast to hit with a mouse; slow the flight down for playability. */
export const PITCH_TIME_SCALE = 1.8;
/** Right-handed release point, projected into zone coordinates. */
export const RELEASE_POINT: Vec2 = { x: -0.8, y: 3.0 };
/** Pitchers cannot target further than this from the zone center. */
export const TARGET_LIMIT = 2.2;
/** Ball radius in zone units; a pitch touching the zone edge is a strike. */
export const BALL_RADIUS = 0.17;

export function flightMsFor(speedKmh: number): number {
  return Math.round((PITCH_DISTANCE_M / (speedKmh / 3.6)) * 1000 * PITCH_TIME_SCALE);
}

export function createPitch(input: PitchInput, rng: Rng): Pitch {
  const spec = PITCH_SPECS[input.type];
  const tx = clamp(input.target.x, -TARGET_LIMIT, TARGET_LIMIT);
  const ty = clamp(input.target.y, -TARGET_LIMIT, TARGET_LIMIT);
  const speedKmh = Math.round(spec.speedKmh + rng.gaussian(0, 1.5));
  return {
    type: input.type,
    speedKmh,
    flightMs: flightMsFor(speedKmh),
    release: { ...RELEASE_POINT },
    plate: { x: tx + rng.gaussian(0, spec.control), y: ty + rng.gaussian(0, spec.control) },
    brk: { ...spec.brk },
  };
}

export interface PitchPosition {
  x: number;
  y: number;
  /** Distance from the plate in meters (0 at the plate, negative after passing it). */
  z: number;
  /** 0 at release, 1 at the plate. */
  progress: number;
}

/** The break grows with progress^BREAK_POWER, so a higher power bends the ball closer to the batter. */
export const BREAK_POWER = 5;

/** Ball position at `tMs` after release. */
export function pitchPositionAt(pitch: Pick<Pitch, 'release' | 'plate' | 'brk' | 'flightMs'>, tMs: number): PitchPosition {
  const p = tMs / pitch.flightMs;
  const bend = Math.sign(p) * Math.abs(p) ** BREAK_POWER;
  return {
    x: lerp(pitch.release.x, pitch.plate.x - pitch.brk.x, p) + pitch.brk.x * bend,
    y: lerp(pitch.release.y, pitch.plate.y - pitch.brk.y, p) + pitch.brk.y * bend,
    z: PITCH_DISTANCE_M * (1 - p),
    progress: p,
  };
}

export function isStrike(plate: Vec2): boolean {
  return Math.abs(plate.x) <= 1 + BALL_RADIUS && Math.abs(plate.y) <= 1 + BALL_RADIUS;
}
