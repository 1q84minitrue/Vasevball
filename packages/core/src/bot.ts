import { flightMsFor, isStrike, PITCH_SPECS } from './pitch';
import type { Rng } from './rng';
import type { GameState } from './rules';
import type { Pitch, PitchInput, PitchType, SwingInput, Vec2 } from './types';

export type BotLevel = 'easy' | 'normal' | 'hard';

interface LevelParams {
  /** How badly the batter misjudges the pitch location (zone units). */
  eye: number;
  timingSd: number;
  aimSd: number;
  /** How much slower pitches fool the batter into swinging early. */
  fooled: number;
  /** How close to the corners the pitcher aims strikes. */
  corner: number;
}

const LEVELS: Record<BotLevel, LevelParams> = {
  easy: { eye: 0.32, timingSd: 65, aimSd: 0.14, fooled: 0.3, corner: 0.6 },
  normal: { eye: 0.22, timingSd: 50, aimSd: 0.1, fooled: 0.2, corner: 0.8 },
  hard: { eye: 0.16, timingSd: 38, aimSd: 0.08, fooled: 0.12, corner: 0.95 },
};

const FASTBALL_FLIGHT_MS = flightMsFor(PITCH_SPECS.fastball.speedKmh);

export function botChoosePitch(state: GameState, rng: Rng, level: BotLevel): PitchInput {
  const { balls, strikes } = state;
  const p = LEVELS[level];
  const type = rng.weighted<PitchType>([
    ['fastball', 45],
    ['slider', 20],
    ['curve', 12],
    ['changeup', 12],
    ['fork', strikes === 2 ? 20 : 8],
    ['sinker', 10],
  ]);

  let strikeChance = 0.45;
  if (balls === 3) strikeChance = 0.7;
  else if (strikes === 2 && balls < 2) strikeChance = 0.25;
  else if (balls >= 2) strikeChance = 0.6;

  let target: Vec2;
  if (rng.chance(strikeChance)) {
    target = { x: rng.range(-p.corner, p.corner), y: rng.range(-p.corner, p.corner) };
  } else {
    const miss = rng.pick(['low', 'outside', 'inside', 'high'] as const);
    target =
      miss === 'low'
        ? { x: rng.range(-1, 1), y: rng.range(-1.7, -1.25) }
        : miss === 'high'
          ? { x: rng.range(-1, 1), y: rng.range(1.25, 1.6) }
          : { x: (miss === 'outside' ? 1 : -1) * rng.range(1.25, 1.7), y: rng.range(-1, 0.8) };
  }
  return { type, target };
}

export function botDecideSwing(state: GameState, pitch: Pitch, rng: Rng, level: BotLevel): SwingInput {
  const p = LEVELS[level];
  const breakSize = Math.hypot(pitch.brk.x, pitch.brk.y);
  const eye = p.eye * (1 + breakSize * 0.35);
  const perceived = { x: pitch.plate.x + rng.gaussian(0, eye), y: pitch.plate.y + rng.gaussian(0, eye) };
  const looksStrike = isStrike(perceived);

  let swingChance = looksStrike ? 0.68 : 0.22;
  if (state.strikes === 2) swingChance = looksStrike ? 0.92 : 0.35;
  else if (state.balls === 3) swingChance = looksStrike ? 0.6 : 0.06;
  else if (state.balls === 0 && state.strikes === 0) swingChance = looksStrike ? 0.5 : 0.12;
  if (!rng.chance(swingChance)) return { swing: false };

  // Sitting on the fastball: slower pitches get swung at early.
  const bias = -(pitch.flightMs - FASTBALL_FLIGHT_MS) * p.fooled;
  return {
    swing: true,
    timeMs: pitch.flightMs + bias + rng.gaussian(0, p.timingSd),
    aim: { x: perceived.x + rng.gaussian(0, p.aimSd), y: perceived.y + rng.gaussian(0, p.aimSd) },
  };
}
