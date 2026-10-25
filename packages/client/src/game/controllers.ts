import { botChoosePitch, botDecideSwing, TIMING_WINDOW_MS } from '@vaseball/core';
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
  private pending: { resolve: (s: SwingInput) => void; releaseAt: number; timer: number } | null = null;

  constructor(private readonly input: InputState) {}

  decideSwing(_state: GameState, pitch: Pitch, releaseAt: number): Promise<SwingInput> {
    return new Promise((resolve) => {
      const giveUpIn = releaseAt - performance.now() + pitch.flightMs + TIMING_WINDOW_MS + 30;
      const timer = window.setTimeout(() => this.finish({ swing: false }), giveUpIn);
      this.pending = { resolve, releaseAt, timer };
    });
  }

  swing(now: number): void {
    if (!this.pending) return;
    this.finish({ swing: true, timeMs: now - this.pending.releaseAt, aim: { ...this.input.aim } });
  }

  private finish(swing: SwingInput): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(swing);
  }
}
