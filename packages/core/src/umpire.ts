import { BASES, runnerArriveSec, type BipResult, type FieldingPlay, type RunnerMove } from './fielding';
import type { Rng } from './rng';
import { distance } from './util';

/** Chance that a base umpire (1B / 2B / 3B) gets an out/safe call wrong. Plays at the plate are the plate umpire's. */
export const BASE_UMPIRE_ERROR_RATE = 0.05;
/** Video this close (seconds between ball and runner) is not always conclusive. */
const CLOSE_PLAY_SEC = 0.08;
const CLOSE_PLAY_OVERTURN = 0.6;
const LAST_INFIELDER = 5;

/** An out/safe call on a runner the throw went to. */
export interface BaseCall {
  /** Index into `play.runners`. */
  runner: number;
  /** 1-3, or 4 for home. */
  base: number;
  /** What really happened. */
  out: boolean;
  /** What the umpire called. */
  calledOut: boolean;
  /** Throw arrival minus runner arrival (seconds): positive means the runner beat it. */
  gap: number;
  /** When the call is made (game seconds after contact). */
  sec: number;
}

export const isWrongCall = (c: BaseCall): boolean => c.out !== c.calledOut;

/** The bang-bang plays of a ball in play: every runner a throw was made to, with the correct calls. */
export function baseCalls(play: FieldingPlay): BaseCall[] {
  if (play.result === 'error') return [];
  const calls: BaseCall[] = [];
  play.runners.forEach((r, i) => {
    if (r.action === 'hold' || r.to === r.from) return;
    const base = BASES[r.to % 4]!;
    const th = play.track.throws.find((t) => !t.carried && distance(t.to, base) < 0.01);
    if (!th) return;
    // An out on the play that is not this throw's (e.g. the batter on a caught fly) is not a call at the base.
    if (r.out && Math.abs(r.outSec - th.arriveSec) > 1e-6) return;
    const arrive = runnerArriveSec(r);
    calls.push({ runner: i, base: r.to, out: r.out, calledOut: r.out, gap: th.arriveSec - arrive, sec: Math.max(arrive, th.arriveSec) });
  });
  return calls;
}

/** The umpires make their calls; each base umpire's is wrong BASE_UMPIRE_ERROR_RATE of the time. */
export function umpireCalls(play: FieldingPlay, rng: Rng, errorRate = BASE_UMPIRE_ERROR_RATE): { play: FieldingPlay; calls: BaseCall[] } {
  const calls = baseCalls(play).map((c) => (c.base <= 3 && rng.chance(errorRate) ? { ...c, calledOut: !c.out } : c));
  return { play: withCalls(play, calls), calls };
}

/** The play as called: runners are out or safe as the umpires say, and the result is scored to match. */
export function withCalls(play: FieldingPlay, calls: BaseCall[]): FieldingPlay {
  if (calls.every((c) => c.calledOut === play.runners[c.runner]!.out)) return play;
  const runners: RunnerMove[] = play.runners.map((r, i) => {
    const c = calls.find((x) => x.runner === i);
    if (!c || c.calledOut === r.out) return r;
    return c.calledOut ? { ...r, out: true, outSec: c.sec } : { ...r, out: false, outSec: 0 };
  });
  const called = { ...play, runners };
  return { ...called, result: rescore(called) };
}

/**
 * Ground balls to the infield are scored by who the umpires called out: a batter called safe at first is
 * credited with an infield hit, a runner called safe on the force makes it a fielder's choice.
 */
function rescore(play: FieldingPlay): BipResult {
  const { track, result } = play;
  const grounder: BipResult[] = ['groundout', 'single', 'doublePlay', 'forceOut', 'fieldersChoice'];
  if (track.kind !== 'ground' || track.fielder < 0 || track.fielder > LAST_INFIELDER || !grounder.includes(result)) return result;
  const batterOut = play.runners.find((r) => r.from === 0)?.out ?? false;
  const first = track.throws[0];
  const forceAtSecond = first !== undefined && distance(first.to, BASES[2]!) < 0.01;
  if (!forceAtSecond) return batterOut ? 'groundout' : 'single';
  const leadOut = play.runners.find((r) => r.from === 1)?.out ?? false;
  if (leadOut) return batterOut ? 'doublePlay' : 'forceOut';
  return batterOut ? 'groundout' : 'fieldersChoice';
}

/** The call a team would ask to have reviewed: one against it, the most doubtful first. */
export function requestableCall(calls: BaseCall[], requesterIsBatting: boolean): BaseCall | null {
  const against = calls.filter((c) => c.calledOut === requesterIsBatting);
  if (against.length === 0) return null;
  return against.reduce((a, b) => {
    if (isWrongCall(a) !== isWrongCall(b)) return isWrongCall(a) ? a : b;
    return Math.abs(b.gap) < Math.abs(a.gap) ? b : a;
  });
}

/**
 * Replay review (NPB リクエスト). A correct call always stands. A wrong one is overturned when the
 * video is conclusive, which it is unless the ball and runner got there at almost the same moment.
 */
export function reviewCall(call: BaseCall, rng: Rng): boolean {
  if (!isWrongCall(call)) return false;
  return Math.abs(call.gap) >= CLOSE_PLAY_SEC || rng.chance(CLOSE_PLAY_OVERTURN);
}

/** The play after the reviewed call is changed to the correct one. */
export function overturnCall(play: FieldingPlay, calls: BaseCall[], call: BaseCall): { play: FieldingPlay; calls: BaseCall[] } {
  const fixed = calls.map((c) => (c.runner === call.runner ? { ...c, calledOut: c.out } : c));
  return { play: withCalls(play, fixed), calls: fixed };
}
