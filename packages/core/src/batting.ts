import { BAT_SPECS, type BatSpec, type BatType } from './bats';
import { isStrike } from './pitch';
import type { Rng } from './rng';
import type { Pitch, SwingInput, Vec2 } from './types';
import { clamp } from './util';

/** Swings further than this from the arrival time (either way) always miss, with the regular bat. */
export const TIMING_WINDOW_MS = BAT_SPECS.normal.timingWindowMs;
/** Radius of the regular bat's hittable area around the aim point, in zone units. */
export const BAT_RADIUS = BAT_SPECS.normal.radius;
/** A bunt meets the ball within this fraction of the bat's radius. */
export const BUNT_REACH = 0.9;
/** A bunt has to be committed to by this long after the ball arrives. */
const BUNT_LATE_MS = 30;

export interface BattedBall {
  exitVeloKmh: number;
  /** Vertical launch angle; negative means into the ground. */
  launchDeg: number;
  /** Horizontal angle: 0 = center field, -45 = left-field line, +45 = right-field line. */
  sprayDeg: number;
  /** Contact quality in [0, 1]. */
  quality: number;
  bunt?: boolean;
  bat?: BatType;
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
/** Where the right-handed batter's helmet is, in zone units (matches the catcher's-eye drawing). */
export const BATTER_HEAD: Vec2 = { x: -3.0, y: 3.0 };
/** Head radius plus the ball radius. */
export const HEAD_HIT_RADIUS = 0.65;

/** Where a taken pitch hits the batter, if it does. */
export function hitByPitchAt(plate: Vec2): 'head' | 'body' | null {
  if (Math.hypot(plate.x - BATTER_HEAD.x, plate.y - BATTER_HEAD.y) <= HEAD_HIT_RADIUS) return 'head';
  if (plate.x < HIT_BY_PITCH_X && plate.y > -2.2 && plate.y < 2.8) return 'body';
  return null;
}

export type SwingOutcome =
  | { kind: 'ball' }
  /** `dangerous`: a fastball to the head, for which the pitcher is ejected (危険球). */
  | { kind: 'hitByPitch'; head?: boolean; dangerous?: boolean }
  | { kind: 'calledStrike' }
  | { kind: 'swingingStrike' }
  | { kind: 'foul'; ball: BattedBall }
  | { kind: 'inPlay'; ball: BattedBall };

export function resolveSwing(pitch: Pitch, swing: SwingInput, rng: Rng, batType: BatType = 'normal'): SwingOutcome {
  const bat = BAT_SPECS[batType];
  if (!swing.swing || (swing.bunt && swing.timeMs > pitch.flightMs + BUNT_LATE_MS)) {
    const hbp = hitByPitchAt(pitch.plate);
    if (hbp === 'head') return { kind: 'hitByPitch', head: true, dangerous: pitch.type === 'fastball' };
    if (hbp) return { kind: 'hitByPitch' };
    return { kind: isStrike(pitch.plate) ? 'calledStrike' : 'ball' };
  }
  if (swing.bunt) return resolveBunt(pitch, swing.aim, rng, batType, bat);

  const window = bat.timingWindowMs;
  const dt = swing.timeMs - pitch.flightMs; // < 0: early
  const dx = pitch.plate.x - swing.aim.x;
  const dy = pitch.plate.y - swing.aim.y; // > 0: ball above the sweet spot
  const dist = Math.hypot(dx, dy);
  if (Math.abs(dt) > window || dist > bat.radius) return { kind: 'swingingStrike' };

  const timingQ = 1 - (dt / window) ** 2;
  const spotQ = 1 - (dist / bat.radius) ** 2;
  const quality = timingQ * spotQ;
  // Weak contact is usually fouled off.
  if (rng.chance(clamp((0.75 - quality * 1.1) * bat.foulRate, 0.1 * bat.foulRate, 0.75))) {
    return { kind: 'foul', ball: foulBall(dt, dy / bat.radius, quality, rng, batType) };
  }

  const exitVeloKmh = clamp((72 + 105 * Math.sqrt(quality)) * powerAt(pitch.plate) * bat.power + rng.gaussian(0, 4), 40, 190);
  const launchDeg = clamp(14 + bat.launchBias + (dy / bat.radius) * 45 + rng.gaussian(0, 5), -40, 80);
  // Right-handed batter: early swings are pulled to left field, outside pitches go the other way.
  const sprayDeg = (dt / window) * 48 + pitch.plate.x * 6 + bat.sprayBias + rng.gaussian(0, 6);
  const ball = { exitVeloKmh, launchDeg, sprayDeg, quality, bat: batType };
  if (Math.abs(sprayDeg) > 45) return { kind: 'foul', ball };

  return { kind: 'inPlay', ball };
}

/**
 * The bat is held still over the plate. Meeting the ball square deadens it into the ground; with the
 * ball above the bat it is popped up. Bunts are slow, and often rolled foul.
 */
function resolveBunt(pitch: Pitch, aim: Vec2, rng: Rng, batType: BatType, bat: BatSpec): SwingOutcome {
  const reach = bat.radius * BUNT_REACH;
  const dy = pitch.plate.y - aim.y;
  const dist = Math.hypot(pitch.plate.x - aim.x, dy);
  if (dist > reach) return { kind: 'swingingStrike' };

  const quality = 1 - (dist / reach) ** 2;
  const exitVeloKmh = clamp((50 + 16 * (1 - quality) + rng.gaussian(0, 6)) * Math.sqrt(bat.power), 30, 80);
  const launchDeg = clamp(-14 + (dy / reach) * 60 + rng.gaussian(0, 6), -40, 70);
  const common = { exitVeloKmh, launchDeg, quality, bunt: true, bat: batType };
  if (rng.chance(clamp(0.55 - quality * 0.45, 0.12, 0.55))) {
    return { kind: 'foul', ball: { ...common, sprayDeg: (rng.chance(0.5) ? -1 : 1) * rng.range(50, 80) } };
  }
  // Pushed toward first or dragged toward third.
  const sprayDeg = clamp(rng.gaussian(0, 20) + bat.sprayBias * 0.5, -44, 44);
  return { kind: 'inPlay', ball: { ...common, sprayDeg } };
}

/** A weakly hit foul: sliced into foul territory on the side the timing points to. */
function foulBall(dt: number, dyRel: number, quality: number, rng: Rng, bat: BatType): BattedBall {
  const side = dt < 0 ? -1 : dt > 0 ? 1 : rng.chance(0.5) ? -1 : 1;
  return {
    exitVeloKmh: clamp((60 + 70 * Math.sqrt(quality)) * BAT_SPECS[bat].power + rng.gaussian(0, 8), 40, 150),
    launchDeg: clamp(14 + dyRel * 45 + rng.gaussian(0, 12), -30, 80),
    sprayDeg: side * rng.range(48, 85),
    quality,
    bat,
  };
}
