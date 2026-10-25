import type { BatType } from './bats';
import { resolveSwing, type SwingOutcome } from './batting';
import { FIELDER_NAMES_JA, resolveBattedBall, resolveFoulBall, type FieldingPlay, type FoulPlay } from './fielding';
import type { Rng } from './rng';
import type { Pitch, Side, SwingInput } from './types';
import { umpireCalls, type BaseCall } from './umpire';

/** NPB: each manager may request two replay reviews through the 9th; an overturned call is not counted. */
export const REQUESTS_PER_GAME = 2;
/** Extra innings come with a fresh allowance, whatever was left over. */
export const REQUESTS_EXTRA_INNINGS = 1;

export interface GameConfig {
  innings: number;
  /** The game is called a tie after this inning. */
  maxInnings: number;
}

export interface TeamInfo {
  name: string;
  short: string;
  lineup: string[];
}

export type Half = 'top' | 'bottom';

export interface GameState {
  config: GameConfig;
  teams: Record<Side, TeamInfo>;
  inning: number;
  half: Half;
  outs: number;
  balls: number;
  strikes: number;
  bases: [boolean, boolean, boolean];
  /** Runs per inning; the current inning is the last element. */
  lineScore: Record<Side, number[]>;
  runs: Record<Side, number>;
  hits: Record<Side, number>;
  /** Index into the lineup of the side's next batter. */
  batterIndex: Record<Side, number>;
  status: 'playing' | 'final';
  winner: Side | 'tie' | null;
  /** The bat each side's batters use. */
  bats: Record<Side, BatType>;
  /** Replay reviews each manager has left. */
  requestsLeft: Record<Side, number>;
  /** Both benches have been warned after a pitch to the head; the next one gets the pitcher ejected. */
  warning: boolean;
}

export type PitchEvent =
  | Exclude<SwingOutcome, { kind: 'inPlay' | 'foul' }>
  /** `play` animates the foul ball; it is absent for fouls without a track (e.g. in tests). */
  | { kind: 'foul'; play?: FoulPlay; bunt?: boolean }
  /**
   * `play` is the play as the umpires called it. `truth` (what really happened) and `calls` are there
   * when the play had out/safe calls, so a replay review can put a wrong call right.
   */
  | { kind: 'inPlay'; play: FieldingPlay; truth?: FieldingPlay; calls?: BaseCall[] };

export interface PitchReport {
  state: GameState;
  messages: string[];
  runs: number;
  paEnded: boolean;
  halfEnded: boolean;
}

export function createGame(teams: Record<Side, TeamInfo>, innings = 9): GameState {
  return {
    config: { innings, maxInnings: innings + 3 },
    teams,
    inning: 1,
    half: 'top',
    outs: 0,
    balls: 0,
    strikes: 0,
    bases: [false, false, false],
    lineScore: { away: [0], home: [] },
    runs: { away: 0, home: 0 },
    hits: { away: 0, home: 0 },
    batterIndex: { away: 0, home: 0 },
    status: 'playing',
    winner: null,
    bats: { away: 'normal', home: 'normal' },
    requestsLeft: { away: REQUESTS_PER_GAME, home: REQUESTS_PER_GAME },
    warning: false,
  };
}

export const battingSide = (s: Pick<GameState, 'half'>): Side => (s.half === 'top' ? 'away' : 'home');
export const fieldingSide = (s: Pick<GameState, 'half'>): Side => (s.half === 'top' ? 'home' : 'away');

export function currentBatter(s: GameState): { order: number; name: string } {
  const side = battingSide(s);
  const i = s.batterIndex[side];
  return { order: i + 1, name: s.teams[side].lineup[i] ?? '' };
}

export function inningLabel(s: Pick<GameState, 'inning' | 'half'>): string {
  return `${s.inning}回${s.half === 'top' ? '表' : '裏'}`;
}

/** Server-side step: turns both players' inputs into a pitch event. */
export function resolvePitchEvent(state: GameState, pitch: Pitch, swing: SwingInput, rng: Rng): PitchEvent {
  const outcome = resolveSwing(pitch, swing, rng, state.bats[battingSide(state)]);
  if (outcome.kind === 'foul') {
    const play = resolveFoulBall(outcome.ball, state.bases, state.outs);
    return play.result === 'foul' ? { kind: 'foul', play, bunt: outcome.ball.bunt } : { kind: 'inPlay', play };
  }
  if (outcome.kind !== 'inPlay') return outcome;
  const truth = resolveBattedBall(outcome.ball, state.bases, state.outs, rng);
  const { play, calls } = umpireCalls(truth, rng);
  return calls.length > 0 ? { kind: 'inPlay', play, truth, calls } : { kind: 'inPlay', play };
}

/** Uses up one of the side's replay reviews, unless the call was overturned. */
export function chargeRequest(prev: GameState, side: Side, overturned: boolean): GameState {
  if (overturned) return prev;
  const s = structuredClone(prev);
  s.requestsLeft[side] = Math.max(0, s.requestsLeft[side] - 1);
  return s;
}

export function applyPitchEvent(prev: GameState, ev: PitchEvent): PitchReport {
  const s = structuredClone(prev);
  const bat = battingSide(s);
  const messages: string[] = [];
  let runs = 0;
  let paEnded = false;
  let halfEnded = false;

  switch (ev.kind) {
    case 'ball':
      s.balls++;
      messages.push('ボール');
      if (s.balls >= 4) {
        messages.push('フォアボール');
        runs += walk(s);
        paEnded = true;
      }
      break;
    case 'hitByPitch':
      messages.push(ev.head ? 'デッドボール (頭部)' : 'デッドボール');
      if (ev.head) {
        // A fastball to the head, or any pitch to the head once the benches are warned, is 危険球退場.
        if (ev.dangerous || s.warning) messages.push('危険球退場! ピッチャー交代');
        else messages.push('警告試合が宣告されました');
        s.warning = true;
      }
      runs += walk(s);
      paEnded = true;
      break;
    case 'calledStrike':
    case 'swingingStrike':
      s.strikes++;
      messages.push(ev.kind === 'calledStrike' ? 'ストライク' : '空振り');
      if (s.strikes >= 3) {
        messages.push(ev.kind === 'calledStrike' ? '見逃し三振' : '空振り三振');
        s.outs++;
        paEnded = true;
      }
      break;
    case 'foul':
      if (ev.bunt && s.strikes >= 2) {
        // A two-strike bunt rolled foul is strike three.
        messages.push('ファウル', 'スリーバント失敗');
        s.strikes++;
        s.outs++;
        paEnded = true;
        break;
      }
      if (s.strikes < 2) s.strikes++;
      messages.push('ファウル');
      break;
    case 'inPlay': {
      const r = applyBallInPlay(s, ev.play);
      messages.push(r.text);
      runs += r.runs;
      paEnded = true;
      break;
    }
  }

  if (runs > 0) {
    s.runs[bat] += runs;
    const line = s.lineScore[bat];
    line[line.length - 1] = (line[line.length - 1] ?? 0) + runs;
    messages.push(`${runs}点が入った!`);
  }
  if (paEnded) {
    s.balls = 0;
    s.strikes = 0;
    s.batterIndex[bat] = (s.batterIndex[bat] + 1) % s.teams[bat].lineup.length;
  }

  if (s.half === 'bottom' && s.inning >= s.config.innings && s.runs.home > s.runs.away) {
    if (runs > 0) messages.push('サヨナラ!');
    finish(s);
  } else if (s.outs >= 3) {
    halfEnded = true;
    endHalf(s);
  }
  if (s.status === 'final') messages.push('ゲームセット');

  return { state: s, messages, runs, paEnded, halfEnded };
}

/** Forced advance on a walk or hit by pitch. Returns runs scored. */
function walk(s: GameState): number {
  const [r1, r2, r3] = s.bases;
  const scores = r1 && r2 && r3 ? 1 : 0;
  s.bases = [true, r1 || s.bases[1], (r1 && r2) || r3];
  return scores;
}

function sprayName(sprayDeg: number): string {
  if (sprayDeg < -15) return 'レフト';
  if (sprayDeg > 15) return 'ライト';
  return 'センター';
}

const BASE_NAMES_JA = ['本塁', '一塁', '二塁', '三塁'] as const;

function applyBallInPlay(s: GameState, play: FieldingPlay): { runs: number; text: string } {
  const bat = battingSide(s);
  const pos = play.fielder >= 0 ? FIELDER_NAMES_JA[play.fielder]! : sprayName(play.batted.sprayDeg);
  const outfield = play.fielder >= 6 ? pos : sprayName(play.batted.sprayDeg);
  let runs = 0;
  let text: string;

  // The runners' moves are decided with the play; a third out wipes out the runs.
  s.outs += play.runners.filter((r) => r.out).length;
  if (s.outs < 3) {
    const safe = play.runners.filter((r) => !r.out);
    runs = safe.filter((r) => r.to === 4).length;
    s.bases = [1, 2, 3].map((b) => safe.some((r) => r.to === b)) as GameState['bases'];
  }

  switch (play.result) {
    case 'single':
      text = play.fielder <= 5 ? `内野安打 (${pos})` : `${outfield}前ヒット`;
      break;
    case 'double':
      text = `${outfield}へのツーベースヒット!`;
      break;
    case 'triple':
      text = `${outfield}へのスリーベースヒット!`;
      break;
    case 'homerun':
      text = `${sprayName(play.batted.sprayDeg)}スタンドへホームラン!! (${Math.round(play.distanceM)}m)`;
      break;
    case 'groundout':
      text = `${pos}ゴロ`;
      break;
    case 'flyout':
    case 'lineout':
    case 'popout':
    case 'foulout': {
      text = play.result === 'lineout' ? `${pos}ライナー` : play.result === 'foulout' ? `${pos}ファウルフライ` : `${pos}フライ`;
      const tagged = play.runners.filter((r) => r.action === 'tagUp');
      const thrownOut = tagged.find((r) => r.out);
      if (thrownOut) text += ` タッチアップ ${BASE_NAMES_JA[thrownOut.to % 4]}タッチアウト!`;
      else if (runs > 0) text += ' 犠牲フライ';
      else if (tagged.length > 0) text += ' タッチアップで進塁';
      break;
    }
    case 'doublePlay':
      text = `${pos}ゴロ ダブルプレー!`;
      break;
    case 'forceOut':
      text = `${pos}ゴロ 二塁フォースアウト`;
      break;
    case 'fieldersChoice':
      text = `${pos}ゴロ フィルダースチョイス`;
      break;
    case 'error':
      text = `${pos}のエラー!`;
      break;
  }
  if (play.batted.bunt) text = buntText(play, pos, text, runs);

  const hit = play.result === 'single' || play.result === 'double' || play.result === 'triple' || play.result === 'homerun';
  // Runners the throw beat on a hit.
  for (const r of play.runners) {
    if (!hit || !r.out || r.from === 0 || r.action !== 'run') continue;
    text += r.to === 4 ? ' 本塁タッチアウト!' : ` ${BASE_NAMES_JA[r.to]}アウト!`;
  }
  if (hit) {
    s.hits[bat]++;
  }
  return { runs, text };
}

function buntText(play: FieldingPlay, pos: string, text: string, runs: number): string {
  const advanced = play.runners.some((r) => r.from > 0 && !r.out && r.to > r.from);
  switch (play.result) {
    case 'groundout':
      if (runs > 0) return `${pos}へのスクイズ成功!`;
      return advanced ? `${pos}への送りバント成功` : `${pos}ゴロ (バント)`;
    case 'single':
      return `バントヒット! (${pos})`;
    case 'forceOut':
      return `バント失敗 ${pos}が二塁封殺`;
    case 'doublePlay':
      return `バント失敗 ダブルプレー!`;
    case 'popout':
    case 'flyout':
    case 'lineout':
    case 'foulout':
      return `バント失敗 ${pos}フライ`;
    default:
      return text;
  }
}

function endHalf(s: GameState): void {
  s.outs = 0;
  s.balls = 0;
  s.strikes = 0;
  s.bases = [false, false, false];
  if (s.half === 'top') {
    if (s.inning >= s.config.innings && s.runs.home > s.runs.away) return finish(s);
    s.half = 'bottom';
    s.lineScore.home.push(0);
  } else {
    if (s.inning >= s.config.innings && s.runs.home !== s.runs.away) return finish(s);
    if (s.inning >= s.config.maxInnings) return finish(s);
    s.inning++;
    if (s.inning === s.config.innings + 1) s.requestsLeft = { away: REQUESTS_EXTRA_INNINGS, home: REQUESTS_EXTRA_INNINGS };
    s.half = 'top';
    s.lineScore.away.push(0);
  }
}

function finish(s: GameState): void {
  s.status = 'final';
  s.winner = s.runs.home > s.runs.away ? 'home' : s.runs.away > s.runs.home ? 'away' : 'tie';
}
