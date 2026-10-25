import { resolveSwing, type SwingOutcome } from './batting';
import { FIELDER_NAMES_JA, resolveBattedBall, resolveFoulBall, type FieldingPlay, type FoulPlay } from './fielding';
import type { Rng } from './rng';
import type { Pitch, Side, SwingInput } from './types';

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
}

export type PitchEvent =
  | Exclude<SwingOutcome, { kind: 'inPlay' | 'foul' }>
  /** `play` animates the foul ball; it is absent for fouls without a track (e.g. in tests). */
  | { kind: 'foul'; play?: FoulPlay }
  | { kind: 'inPlay'; play: FieldingPlay };

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
  const outcome = resolveSwing(pitch, swing, rng);
  if (outcome.kind === 'foul') {
    const play = resolveFoulBall(outcome.ball, state.bases, state.outs);
    return play.result === 'foul' ? { kind: 'foul', play } : { kind: 'inPlay', play };
  }
  if (outcome.kind !== 'inPlay') return outcome;
  return { kind: 'inPlay', play: resolveBattedBall(outcome.ball, state.bases, state.outs, rng) };
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
      messages.push('デッドボール');
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
    case 'error':
      text = `${pos}のエラー!`;
      break;
  }

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
    s.half = 'top';
    s.lineScore.away.push(0);
  }
}

function finish(s: GameState): void {
  s.status = 'final';
  s.winner = s.runs.home > s.runs.away ? 'home' : s.runs.away > s.runs.home ? 'away' : 'tie';
}
