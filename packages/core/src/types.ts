/**
 * 2D vector.
 * - In strike-zone coordinates (pitch/swing), the strike zone spans x,y ∈ [-1, 1].
 *   +x is the catcher's right (first-base side), +y is up.
 * - In field coordinates (meters), home plate is the origin, +y points to center field
 *   and +x to the first-base side.
 */
export interface Vec2 {
  x: number;
  y: number;
}

export type Side = 'away' | 'home';

export type PitchType = 'fastball' | 'slider' | 'curve' | 'changeup' | 'fork' | 'sinker';

/** What the pitcher decides. This is the only input sent by the pitching player. */
export interface PitchInput {
  type: PitchType;
  /** Intended location at the plate (zone coordinates). */
  target: Vec2;
}

/** A thrown pitch, fully determined at release time. */
export interface Pitch {
  type: PitchType;
  speedKmh: number;
  /** Time from release until the ball crosses the plate. */
  flightMs: number;
  /** Release point, projected into zone coordinates. */
  release: Vec2;
  /** Where the ball actually crosses the plate (after control error). */
  plate: Vec2;
  /** Total late break, used for the trajectory shape. */
  brk: Vec2;
}

/** What the batter decides. This is the only input sent by the batting player. */
export type SwingInput =
  | { swing: false }
  | {
      swing: true;
      /** Milliseconds after release when the bat reaches the contact point. */
      timeMs: number;
      /** Where the batter aimed the sweet spot (zone coordinates). */
      aim: Vec2;
      /** The bat is held out over the plate instead of swung; `timeMs` is when the batter commits. */
      bunt?: boolean;
    };
