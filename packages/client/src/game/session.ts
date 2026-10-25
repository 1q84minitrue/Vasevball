import {
  applyPitchEvent,
  battingSide,
  createGame,
  createPitch,
  fieldingSide,
  makeTeam,
  resolvePitchEvent,
  Rng,
  runnerArriveSec,
} from '@vaseball/core';
import type { BotLevel, FieldingPlay, FoulPlay, GameState, Pitch, PitchEvent, Side, SwingInput, Vec2 } from '@vaseball/core';
import { BotBatter, BotPitcher, type BatterController, type HumanBatter, type HumanPitcher, type PitcherController } from './controllers';

export const WINDUP_MS = 700;
/** Balls in play are animated faster than real time. */
export const PLAY_SPEED = 1.6;
/** The pitch view freezes this long when the bat meets the ball. */
export const HIT_STOP_MS = 50;

export function isContact(event: PitchEvent | null): boolean {
  return event?.kind === 'inPlay' || event?.kind === 'foul';
}

export interface PitchPhase {
  kind: 'pitch';
  pitch: Pitch;
  target: Vec2;
  releaseAt: number;
  humanPitching: boolean;
  humanBatting: boolean;
  swing: SwingInput | null;
  /** Known as soon as the swing is decided, so the ball can react on contact. */
  event: PitchEvent | null;
}

export type Phase =
  | { kind: 'idle' }
  | { kind: 'aiming'; humanPitching: boolean; humanBatting: boolean }
  | PitchPhase
  | {
      kind: 'result';
      pitch: Pitch;
      swing: SwingInput;
      event: PitchEvent;
      releaseAt: number;
      humanBatting: boolean;
      /** Strike three: the batter rises to heaven. */
      strikeout: boolean;
      messages: string[];
      startAt: number;
    }
  | { kind: 'inPlay'; play: FieldingPlay | FoulPlay; before: GameState; messages: string[]; startAt: number }
  | { kind: 'change'; text: string; startAt: number }
  | { kind: 'final' };

export interface SessionOptions {
  humanSide: Side;
  innings: number;
  level: BotLevel;
  seed?: number;
}

const now = () => performance.now();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long (real time) a player who is out spends rising to heaven before vanishing. */
export const ASCEND_MS = 1800;
/** ASCEND_MS in the sped-up game seconds of the field view. */
export const ASCEND_SEC = (ASCEND_MS / 1000) * PLAY_SPEED;
/** Pause after strike three before the batter starts rising. */
export const STRIKEOUT_ASCEND_DELAY_MS = 300;

/** How long the result stays up after the play is over (game seconds). */
const RESULT_HOLD_SEC = 1.8;
const MAX_PLAY_MS = 9000;

/** When the play is over: the ball is dead and every runner is on a base or out (game seconds). */
function playEndSec(play: FieldingPlay | FoulPlay): number {
  const t = play.track;
  if (play.result === 'foul') return t.fieldSec;
  if (play.result === 'homerun') return t.hangSec;
  const lastThrow = t.throws[t.throws.length - 1]?.arriveSec ?? 0;
  const running = play.runners.map((r) => {
    if (r.out) return r.outSec;
    if (r.action === 'hold') return t.fieldSec + 1;
    return runnerArriveSec(r);
  });
  return Math.max(t.fieldSec, lastThrow, ...running);
}

/** When the field view shows the result (game seconds), early enough to be read before the cut. */
export function resultShownSec(play: FieldingPlay | FoulPlay): number {
  return Math.min(playEndSec(play), (MAX_PLAY_MS / 1000) * PLAY_SPEED - RESULT_HOLD_SEC);
}

export function playDurationMs(play: FieldingPlay | FoulPlay): number {
  const ascents = play.runners.filter((r) => r.out).map((r) => r.outSec + ASCEND_SEC);
  const endSec = Math.max(playEndSec(play) + RESULT_HOLD_SEC, ...ascents);
  return Math.min(MAX_PLAY_MS, Math.max(play.result === 'foul' ? 1500 : 2000, (endSec / PLAY_SPEED) * 1000));
}

/**
 * Runs an offline match. The flow (pitch input → pitch → swing input → resolve) mirrors what
 * a server-authoritative online match will do, with controllers standing in for the players.
 */
export class GameSession {
  state: GameState;
  phase: Phase = { kind: 'idle' };
  readonly humanSide: Side;
  /** Called after every plate appearance with the state from before the deciding pitch. */
  onLog: ((messages: string[], before: GameState) => void) | null = null;
  onFinal: ((state: GameState) => void) | null = null;

  private readonly rng: Rng;
  private readonly controllers: Record<Side, { pitcher: PitcherController; batter: BatterController }>;
  private stopped = false;

  constructor(opts: SessionOptions, human: { pitcher: HumanPitcher; batter: HumanBatter }) {
    const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 32);
    this.rng = new Rng(seed);
    const botRng = new Rng(seed ^ 0x9e3779b9);
    this.humanSide = opts.humanSide;
    const humanTeam = makeTeam('あなた', 'YOU', 0);
    const cpuTeam = makeTeam('CPU', 'CPU', 9);
    const humanCtl = { pitcher: human.pitcher, batter: human.batter };
    const botCtl = { pitcher: new BotPitcher(opts.level, botRng), batter: new BotBatter(opts.level, botRng) };
    if (opts.humanSide === 'away') {
      this.state = createGame({ away: humanTeam, home: cpuTeam }, opts.innings);
      this.controllers = { away: humanCtl, home: botCtl };
    } else {
      this.state = createGame({ away: cpuTeam, home: humanTeam }, opts.innings);
      this.controllers = { away: botCtl, home: humanCtl };
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    this.phase = { kind: 'change', text: 'プレイボール!', startAt: now() };
    await sleep(1500);

    while (this.state.status === 'playing' && !this.stopped) {
      const pitcher = this.controllers[fieldingSide(this.state)].pitcher;
      const batter = this.controllers[battingSide(this.state)].batter;
      const humanPitching = pitcher.kind === 'human';
      const humanBatting = batter.kind === 'human';

      this.phase = { kind: 'aiming', humanPitching, humanBatting };
      const input = await pitcher.choosePitch(this.state);
      if (this.stopped) return;

      const pitch = createPitch(input, this.rng);
      const releaseAt = now() + WINDUP_MS;
      const pitchPhase: PitchPhase = {
        kind: 'pitch',
        pitch,
        target: input.target,
        releaseAt,
        humanPitching,
        humanBatting,
        swing: null,
        event: null,
      };
      this.phase = pitchPhase;

      const swing = await batter.decideSwing(this.state, pitch, releaseAt);
      if (this.stopped) return;
      const event = resolvePitchEvent(this.state, pitch, swing, this.rng);
      pitchPhase.swing = swing;
      pitchPhase.event = event;
      await sleep(releaseAt + pitch.flightMs + 350 + (isContact(event) ? HIT_STOP_MS : 0) - now());
      if (this.stopped) return;

      const before = this.state;
      const report = applyPitchEvent(before, event);
      const play = event.kind === 'inPlay' || event.kind === 'foul' ? event.play : undefined;
      if (play) {
        this.phase = { kind: 'inPlay', play, before, messages: report.messages, startAt: now() };
        await sleep(playDurationMs(play));
        this.state = report.state;
      } else {
        this.state = report.state;
        const strikeout = report.paEnded && (event.kind === 'calledStrike' || event.kind === 'swingingStrike');
        this.phase = {
          kind: 'result',
          pitch,
          swing,
          event,
          releaseAt,
          humanBatting,
          strikeout,
          messages: report.messages,
          startAt: now(),
        };
        await sleep(strikeout ? STRIKEOUT_ASCEND_DELAY_MS + ASCEND_MS + 300 : report.paEnded ? 1500 : 1000);
      }
      if (this.stopped) return;
      if (report.paEnded) this.onLog?.(report.messages, before);

      if (report.halfEnded && this.state.status === 'playing') {
        const attacking = battingSide(this.state) === this.humanSide ? 'あなたの攻撃' : 'CPUの攻撃';
        this.phase = { kind: 'change', text: `チェンジ — ${attacking}`, startAt: now() };
        await sleep(1600);
      }
    }

    if (this.stopped) return;
    this.phase = { kind: 'final' };
    this.onFinal?.(this.state);
  }
}
