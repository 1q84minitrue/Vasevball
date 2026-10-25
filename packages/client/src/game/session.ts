import {
  applyPitchEvent,
  BAT_TYPES,
  battingSide,
  chargeRequest,
  createGame,
  createPitch,
  fieldingSide,
  isWrongCall,
  makeTeam,
  overturnCall,
  requestableCall,
  resolvePitchEvent,
  reviewCall,
  Rng,
  runnerArriveSec,
} from '@vaseball/core';
import type {
  BaseCall,
  BatType,
  BotLevel,
  FieldingPlay,
  FoulPlay,
  GameState,
  Pitch,
  PitchEvent,
  PitchReport,
  Side,
  SwingInput,
  Vec2,
} from '@vaseball/core';
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
  bat: BatType;
  swing: SwingInput | null;
  /** Known as soon as the swing is decided, so the ball can react on contact. */
  event: PitchEvent | null;
}

/** A manager asking for a replay review of a call. */
export interface ReviewRequest {
  side: Side;
  call: BaseCall;
  at: number;
}

export interface InPlayPhase {
  kind: 'inPlay';
  play: FieldingPlay | FoulPlay;
  before: GameState;
  messages: string[];
  startAt: number;
  /** The umpires' out/safe calls on the play. */
  calls: BaseCall[];
  request: ReviewRequest | null;
}

export interface ReviewPhase {
  kind: 'review';
  /** What really happened: the replay shows it. */
  truth: FieldingPlay;
  before: GameState;
  request: ReviewRequest;
  startAt: number;
  verdict: { overturned: boolean; lines: string[]; at: number } | null;
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
      bat: BatType;
      /** Strike three: the batter rises to heaven. */
      strikeout: boolean;
      messages: string[];
      startAt: number;
    }
  | InPlayPhase
  | ReviewPhase
  | { kind: 'change'; text: string; startAt: number }
  | { kind: 'final' };

/** Something worth a sound effect. */
export type Cue =
  | { kind: 'playball' | 'mitt' | 'strikeout' | 'homerun' | 'change' | 'time' | 'request' | 'gameset' }
  | { kind: 'hit'; bat: BatType; quality: number; bunt: boolean; foul: boolean }
  | { kind: 'hbp'; head: boolean }
  | { kind: 'cheer'; big: boolean }
  | { kind: 'call'; out: boolean }
  | { kind: 'verdict'; overturned: boolean };

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

/** The replay runs from this long before the call to a little after it (game seconds), in slow motion. */
export const REPLAY_LEAD_SEC = 1.8;
export const REPLAY_TAIL_SEC = 0.6;
export const REPLAY_SPEED = 0.45;
export const REPLAY_MS = ((REPLAY_LEAD_SEC + REPLAY_TAIL_SEC) / REPLAY_SPEED) * 1000;
const VERDICT_MS = 3200;
/** The CPU manager asks for a review of a wrong call against it this often, and of a close right one this often. */
const BOT_REQUEST_WRONG = 0.8;
const BOT_REQUEST_CLOSE = 0.15;
const CLOSE_SEC = 0.2;

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

const BASE_JA = ['', '一塁', '二塁', '三塁', '本塁'];
const callWord = (out: boolean) => (out ? 'アウト' : 'セーフ');

/**
 * Runs an offline match. The flow (pitch input → pitch → swing input → resolve) mirrors what
 * a server-authoritative online match will do, with controllers standing in for the players.
 */
export class GameSession {
  state: GameState;
  phase: Phase = { kind: 'idle' };
  readonly humanSide: Side;
  /** タイム: the game waits before the next pitch until it is lifted. */
  paused = false;
  /** Called after every plate appearance with the state from before the deciding pitch. */
  onLog: ((messages: string[], before: GameState) => void) | null = null;
  onFinal: ((state: GameState) => void) | null = null;
  onCue: ((cue: Cue) => void) | null = null;

  private readonly rng: Rng;
  private readonly botRng: Rng;
  private readonly controllers: Record<Side, { pitcher: PitcherController; batter: BatterController }>;
  private stopped = false;
  private resumers: (() => void)[] = [];
  /** The CPU picks a bat at random for each of its plate appearances. */
  private cpuNeedsBat = true;

  constructor(opts: SessionOptions, human: { pitcher: HumanPitcher; batter: HumanBatter }) {
    const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 32);
    this.rng = new Rng(seed);
    const botRng = new Rng(seed ^ 0x9e3779b9);
    this.botRng = botRng;
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

  get cpuSide(): Side {
    return this.humanSide === 'away' ? 'home' : 'away';
  }

  stop(): void {
    this.stopped = true;
    this.resume();
  }

  /** Time can be called between pitches, not once the pitcher has started his motion. */
  canCallTime(): boolean {
    const k = this.phase.kind;
    return !this.paused && this.state.status === 'playing' && (k === 'aiming' || k === 'result' || k === 'change');
  }

  callTime(): boolean {
    if (!this.canCallTime()) return false;
    this.paused = true;
    this.cue({ kind: 'time' });
    return true;
  }

  resume(): void {
    this.paused = false;
    const fns = this.resumers;
    this.resumers = [];
    fns.forEach((f) => f());
  }

  setBat(side: Side, bat: BatType): void {
    this.state = { ...this.state, bats: { ...this.state.bats, [side]: bat } };
  }

  /**
   * The manager of `side` asks for a replay review while the play is on screen.
   * Returns why it cannot be done, or null when the request is accepted.
   */
  requestReview(side: Side): string | null {
    const phase = this.phase;
    if (phase.kind !== 'inPlay' || phase.play.result === 'foul') return 'リクエストできるのはプレーの映像が流れている間だけです';
    if (phase.request) return 'このプレーはすでにリクエスト中です';
    if (phase.before.requestsLeft[side] <= 0) return 'リクエストの権利が残っていません';
    const call = requestableCall(phase.calls, side === battingSide(phase.before));
    if (!call) return 'リクエストの対象になる判定がありません';
    if (now() < phase.startAt + (call.sec / PLAY_SPEED) * 1000) return 'まだ判定が出ていません';
    phase.request = { side, call, at: now() };
    this.cue({ kind: 'request' });
    return null;
  }

  private cue(c: Cue, delayMs = 0): void {
    if (delayMs <= 0) {
      this.onCue?.(c);
      return;
    }
    setTimeout(() => {
      if (!this.stopped) this.onCue?.(c);
    }, delayMs);
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.stopped) await new Promise<void>((resolve) => this.resumers.push(resolve));
  }

  async run(): Promise<void> {
    this.phase = { kind: 'change', text: 'プレイボール!', startAt: now() };
    this.cue({ kind: 'playball' });
    await sleep(1500);

    while (this.state.status === 'playing' && !this.stopped) {
      await this.waitWhilePaused();
      if (this.stopped) return;
      if (this.cpuNeedsBat && battingSide(this.state) === this.cpuSide) {
        this.setBat(this.cpuSide, this.botRng.pick(BAT_TYPES));
        this.cpuNeedsBat = false;
      }
      const pitcher = this.controllers[fieldingSide(this.state)].pitcher;
      const batter = this.controllers[battingSide(this.state)].batter;
      const humanPitching = pitcher.kind === 'human';
      const humanBatting = batter.kind === 'human';

      this.phase = { kind: 'aiming', humanPitching, humanBatting };
      const input = await pitcher.choosePitch(this.state);
      await this.waitWhilePaused();
      if (this.stopped) return;

      const bat = this.state.bats[battingSide(this.state)];
      const pitch = createPitch(input, this.rng);
      const releaseAt = now() + WINDUP_MS;
      const pitchPhase: PitchPhase = {
        kind: 'pitch',
        pitch,
        target: input.target,
        releaseAt,
        humanPitching,
        humanBatting,
        bat,
        swing: null,
        event: null,
      };
      this.phase = pitchPhase;

      const swing = await batter.decideSwing(this.state, pitch, releaseAt);
      if (this.stopped) return;
      const event = resolvePitchEvent(this.state, pitch, swing, this.rng);
      pitchPhase.swing = swing;
      pitchPhase.event = event;
      this.cuePitch(event, bat, releaseAt + pitch.flightMs - now());
      await sleep(releaseAt + pitch.flightMs + 350 + (isContact(event) ? HIT_STOP_MS : 0) - now());
      if (this.stopped) return;

      const before = this.state;
      let report = applyPitchEvent(before, event);
      const play = event.kind === 'inPlay' || event.kind === 'foul' ? event.play : undefined;
      if (play) {
        const calls = event.kind === 'inPlay' ? (event.calls ?? []) : [];
        const phase: InPlayPhase = { kind: 'inPlay', play, before, messages: report.messages, startAt: now(), calls, request: null };
        this.phase = phase;
        this.cuePlay(phase);
        this.considerBotRequest(phase);
        await sleep(playDurationMs(play));
        if (this.stopped) return;
        if (phase.request && event.kind === 'inPlay' && event.truth) report = await this.review(phase, phase.request, event, before);
        if (this.stopped) return;
        this.state = report.state;
      } else {
        this.state = report.state;
        const strikeout = report.paEnded && (event.kind === 'calledStrike' || event.kind === 'swingingStrike');
        if (strikeout) this.cue({ kind: 'strikeout' }, STRIKEOUT_ASCEND_DELAY_MS);
        this.phase = {
          kind: 'result',
          pitch,
          swing,
          event,
          releaseAt,
          humanBatting,
          bat,
          strikeout,
          messages: report.messages,
          startAt: now(),
        };
        await sleep(strikeout ? STRIKEOUT_ASCEND_DELAY_MS + ASCEND_MS + 300 : report.paEnded ? 1500 : 1000);
      }
      if (this.stopped) return;
      if (report.paEnded) this.onLog?.(report.messages, before);
      if (report.paEnded || report.halfEnded) this.cpuNeedsBat = true;

      if (report.halfEnded && this.state.status === 'playing') {
        const attacking = battingSide(this.state) === this.humanSide ? 'あなたの攻撃' : 'CPUの攻撃';
        this.phase = { kind: 'change', text: `チェンジ — ${attacking}`, startAt: now() };
        this.cue({ kind: 'change' });
        await sleep(1600);
      }
    }

    if (this.stopped) return;
    this.phase = { kind: 'final' };
    this.cue({ kind: 'gameset' });
    this.onFinal?.(this.state);
  }

  private cuePitch(event: PitchEvent, bat: BatType, contactInMs: number): void {
    if (event.kind === 'hitByPitch') return this.cue({ kind: 'hbp', head: !!event.head }, contactInMs);
    if (event.kind === 'inPlay' || event.kind === 'foul') {
      const batted = event.play?.batted;
      return this.cue(
        { kind: 'hit', bat, quality: batted?.quality ?? 0.3, bunt: !!batted?.bunt, foul: event.kind === 'foul' || event.play.result === 'foulout' },
        contactInMs,
      );
    }
    this.cue({ kind: 'mitt' }, contactInMs);
  }

  private cuePlay(phase: InPlayPhase): void {
    const { play } = phase;
    const ms = (sec: number) => (sec / PLAY_SPEED) * 1000;
    if (play.result === 'homerun') {
      this.cue({ kind: 'homerun' }, ms(play.track.hangSec));
      this.cue({ kind: 'cheer', big: true }, ms(play.track.hangSec));
    } else if (play.result === 'single' || play.result === 'double' || play.result === 'triple') {
      this.cue({ kind: 'cheer', big: play.result !== 'single' }, ms(play.track.fieldSec));
    }
    for (const c of phase.calls) this.cue({ kind: 'call', out: c.calledOut }, ms(c.sec));
  }

  /** The CPU manager sees what the umpires got wrong about as well as a fan watching the replay. */
  private considerBotRequest(phase: InPlayPhase): void {
    const side = this.cpuSide;
    if (phase.before.requestsLeft[side] <= 0) return;
    const call = requestableCall(phase.calls, side === battingSide(phase.before));
    if (!call) return;
    const chance = isWrongCall(call) ? BOT_REQUEST_WRONG : Math.abs(call.gap) < CLOSE_SEC ? BOT_REQUEST_CLOSE : 0;
    if (!this.botRng.chance(chance)) return;
    const at = Math.min((call.sec / PLAY_SPEED) * 1000 + 900, playDurationMs(phase.play) - 300);
    setTimeout(() => {
      if (!this.stopped && this.phase === phase && !phase.request) this.requestReview(side);
    }, at);
  }

  /** Replay review: the umpires watch the video, then the crew chief announces the ruling. */
  private async review(phase: InPlayPhase, request: ReviewRequest, event: Extract<PitchEvent, { kind: 'inPlay' }>, before: GameState): Promise<PitchReport> {
    const truth = event.truth!;
    const calls = event.calls ?? phase.calls;
    const review: ReviewPhase = { kind: 'review', truth, before, request, startAt: now(), verdict: null };
    this.phase = review;
    await sleep(REPLAY_MS);
    if (this.stopped) return applyPitchEvent(before, event);

    const { call } = request;
    const overturned = reviewCall(call, this.rng);
    const ruled = overturned ? { ...event, ...overturnCall(truth, calls, call) } : event;
    const report = applyPitchEvent(chargeRequest(before, request.side, overturned), ruled);
    const runner = truth.runners[call.runner]!;
    const who = runner.from === 0 ? '打者走者' : `${BASE_JA[runner.from]}走者`;
    const lines = [
      'リプレー検証の結果',
      overturned
        ? `判定を覆し ${who}は${callWord(call.out)}とします`
        : `判定通り ${who}は${callWord(call.calledOut)}とします`,
    ];
    if (overturned) lines.push(report.messages[0] ?? '');
    review.verdict = { overturned, lines, at: now() };
    this.cue({ kind: 'verdict', overturned });
    await sleep(VERDICT_MS);
    const who2 = request.side === this.humanSide ? 'あなた' : 'CPU';
    report.messages.push(overturned ? `(${who2}のリクエストで判定が覆った)` : `(${who2}のリクエスト: 判定通り)`);
    return report;
  }
}
