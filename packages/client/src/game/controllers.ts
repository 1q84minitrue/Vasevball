import { BAT_SPECS, battingSide, botChoosePitch, botDecideSwing, BUNT_COMMIT_MS } from '@vaseball/core';
import type { BotLevel, GameState, Pitch, PitchInput, Rng, SwingInput } from '@vaseball/core';
import type { InputState } from './input';

/**
 * A source of player decisions. The session does not care whether a decision comes
 * from the local player, a bot, or (later) a remote player over the network.
 */
export interface PitcherController {
  readonly kind: 'human' | 'bot';
  choosePitch(state: GameState): Promise<PitchInput>;
}

export interface BatterController {
  readonly kind: 'human' | 'bot';
  /** `releaseAt` is the performance.now() timestamp at which the ball leaves the hand. */
  decideSwing(state: GameState, pitch: Pitch, releaseAt: number): Promise<SwingInput>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** A swing can still connect this long after the ball arrives, with the most forgiving bat. */
const LATEST_SWING_MS = Math.max(...Object.values(BAT_SPECS).map((b) => b.timingWindowMs));

export class BotPitcher implements PitcherController {
  readonly kind = 'bot';
  constructor(
    private readonly level: BotLevel,
    private readonly rng: Rng,
  ) {}

  async choosePitch(state: GameState): Promise<PitchInput> {
    await sleep(this.rng.range(500, 1100));
    return botChoosePitch(state, this.rng, this.level);
  }
}

export class BotBatter implements BatterController {
  readonly kind = 'bot';
  constructor(
    private readonly level: BotLevel,
    private readonly rng: Rng,
  ) {}

  decideSwing(state: GameState, pitch: Pitch): Promise<SwingInput> {
    return Promise.resolve(botDecideSwing(state, pitch, this.rng, this.level));
  }
}

export class HumanPitcher implements PitcherController {
  readonly kind = 'human';
  private resolve: ((input: PitchInput) => void) | null = null;

  constructor(private readonly input: InputState) {}

  choosePitch(): Promise<PitchInput> {
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  throwPitch(): void {
    const resolve = this.resolve;
    if (!resolve) return;
    this.resolve = null;
    resolve({ type: this.input.pitchType, target: { ...this.input.aim } });
  }
}

export class HumanBatter implements BatterController {
  readonly kind = 'human';
  private pending: { resolve: (s: SwingInput) => void; releaseAt: number; swingDelayMs: number; timers: number[] } | null = null;

  constructor(private readonly input: InputState) {}

  decideSwing(state: GameState, pitch: Pitch, releaseAt: number): Promise<SwingInput> {
    const swingDelayMs = BAT_SPECS[state.bats[battingSide(state)]].swingDelayMs;
    return new Promise((resolve) => {
      const arriveIn = releaseAt - performance.now() + pitch.flightMs;
      // Still squared around (B held) just before the ball gets there: the bunt is on. Letting go pulls the bat back.
      const bunt = window.setTimeout(() => {
        if (this.input.buntHeld && this.pending) {
          this.finish({ swing: true, bunt: true, timeMs: performance.now() - this.pending.releaseAt, aim: { ...this.input.aim } });
        }
      }, arriveIn - BUNT_COMMIT_MS);
      const giveUp = window.setTimeout(() => this.finish({ swing: false }), arriveIn + LATEST_SWING_MS + 30);
      this.pending = { resolve, releaseAt, swingDelayMs, timers: [bunt, giveUp] };
    });
  }

  swing(now: number): void {
    if (!this.pending) return;
    // Heavy bats get to the contact point a while after the button is pressed.
    const { releaseAt, swingDelayMs } = this.pending;
    this.finish({ swing: true, timeMs: now - releaseAt + swingDelayMs, aim: { ...this.input.aim } });
  }

  private finish(swing: SwingInput): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.timers.forEach((t) => clearTimeout(t));
    pending.resolve(swing);
  }
}
