import { isStrike } from './pitch';
import type { Rng } from './rng';
import type { Pitch, SwingInput, Vec2 } from './types';
import { clamp } from './util';

/** Swings further than this from the arrival time (either way) always miss. */
export const TIMING_WINDOW_MS = 100;
/** Radius of the bat's hittable area around the aim point, in zone units. */
export const BAT_RADIUS = 0.5;

export interface BattedBall {
  exitVeloKmh: number;
  /** Vertical launch angle; negative means into the ground. */
  launchDeg: number;
  /** Horizontal angle: 0 = center field, -45 = left-field line, +45 = right-field line. */
  sprayDeg: number;
  /** Contact quality in [0, 1]. */
  quality: number;
}

/** Exit velocity lost per zone unit the contact point is outside the middle square of the zone. */
const POWER_FALLOFF = 0.04;
const MIN_POWER = 0.6;

/** Full power in the middle square of the 3×3 zone grid, tapering off the further out the ball is met. */
export function powerAt(plate: Vec2): number {
  const off = Math.max(Math.abs(plate.x), Math.abs(plate.y)) - 1 / 3;
  return clamp(1 - POWER_FALLOFF * Math.max(0, off), MIN_POWER, 1);
}

/** A taken pitch this far inside (zone x, right-handed batter's side) hits the batter. */
export const HIT_BY_PITCH_X = -1.9;

export type SwingOutcome =
  | { kind: 'ball' }
  | { kind: 'hitByPitch' }
  | { kind: 'calledStrike' }
  | { kind: 'swingingStrike' }
  | { kind: 'foul'; ball: BattedBall }
  | { kind: 'inPlay'; ball: BattedBall };

export function resolveSwing(pitch: Pitch, swing: SwingInput, rng: Rng): SwingOutcome {
  if (!swing.swing) {
    if (pitch.plate.x < HIT_BY_PITCH_X && pitch.plate.y > -2.2 && pitch.plate.y < 2.8) return { kind: 'hitByPitch' };
    return { kind: isStrike(pitch.plate) ? 'calledStrike' : 'ball' };
  }

  const dt = swing.timeMs - pitch.flightMs; // < 0: early
  const dx = pitch.plate.x - swing.aim.x;
  const dy = pitch.plate.y - swing.aim.y; // > 0: ball above the sweet spot
  const dist = Math.hypot(dx, dy);
  if (Math.abs(dt) > TIMING_WINDOW_MS || dist > BAT_RADIUS) return { kind: 'swingingStrike' };

  const timingQ = 1 - (dt / TIMING_WINDOW_MS) ** 2;
  const spotQ = 1 - (dist / BAT_RADIUS) ** 2;
  const quality = timingQ * spotQ;
  // Weak contact is usually fouled off.
  if (rng.chance(clamp(0.75 - quality * 1.1, 0.1, 0.75))) return { kind: 'foul', ball: foulBall(dt, dy, quality, rng) };

  const exitVeloKmh = clamp((72 + 105 * Math.sqrt(quality)) * powerAt(pitch.plate) + rng.gaussian(0, 4), 40, 185);
  const launchDeg = clamp(14 + (dy / BAT_RADIUS) * 45 + rng.gaussian(0, 5), -40, 80);
  // Right-handed batter: early swings are pulled to left field, outside pitches go the other way.
  const sprayDeg = (dt / TIMING_WINDOW_MS) * 48 + pitch.plate.x * 6 + rng.gaussian(0, 6);
  const ball = { exitVeloKmh, launchDeg, sprayDeg, quality };
  if (Math.abs(sprayDeg) > 45) return { kind: 'foul', ball };

  return { kind: 'inPlay', ball };
}

/** A weakly hit foul: sliced into foul territory on the side the timing points to. */
function foulBall(dt: number, dy: number, quality: number, rng: Rng): BattedBall {
  const side = dt < 0 ? -1 : dt > 0 ? 1 : rng.chance(0.5) ? -1 : 1;
  return {
    exitVeloKmh: clamp(60 + 70 * Math.sqrt(quality) + rng.gaussian(0, 8), 40, 150),
    launchDeg: clamp(14 + (dy / BAT_RADIUS) * 45 + rng.gaussian(0, 12), -30, 80),
    sprayDeg: side * rng.range(48, 85),
    quality,
  };
}
