import type { BattedBall } from './batting';
import type { Rng } from './rng';
import type { Vec2 } from './types';
import { deg2rad, distance, lerp, lerpVec } from './util';

/** Runners on [first, second, third]. */
export type Bases = readonly [boolean, boolean, boolean];

export type BipResult =
  | 'single'
  | 'double'
  | 'triple'
  | 'homerun'
  | 'groundout'
  | 'flyout'
  | 'lineout'
  | 'popout'
  | 'doublePlay'
  | 'forceOut'
  | 'foulout'
  | 'fieldersChoice'
  | 'error';

/** Home, first, second, third (field coordinates, meters). */
export const BASES: readonly Vec2[] = [
  { x: 0, y: 0 },
  { x: 19.4, y: 19.4 },
  { x: 0, y: 38.8 },
  { x: -19.4, y: 19.4 },
];

/** Ordered by scorebook position number: P, C, 1B, 2B, 3B, SS, LF, CF, RF. */
export const DEFAULT_FIELDERS: readonly Vec2[] = [
  { x: 0, y: 18 },
  { x: 0, y: -1.5 },
  { x: 21, y: 26 },
  { x: 11, y: 38 },
  { x: -21, y: 26 },
  { x: -11, y: 38 },
  { x: -30, y: 82 },
  { x: 0, y: 96 },
  { x: 30, y: 82 },
];
export const FIELDER_LABELS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'] as const;
export const FIELDER_NAMES_JA = ['ピッチャー', 'キャッチャー', 'ファースト', 'セカンド', 'サード', 'ショート', 'レフト', 'センター', 'ライト'] as const;
const CATCHER = 1;
const FIRST_BASEMAN = 2;
const LAST_INFIELDER = 5;

const G = 9.8;
/** Fraction of vacuum carry distance a ball actually travels (air drag). */
const CARRY = 0.62;
const HANG_FACTOR = 0.75;
const PEAK_FACTOR = 0.6;
export const GROUND_LAUNCH_DEG = 10;
const LINER_DEG = 20;
const POPUP_DEG = 50;

export const FIELDER_SPEED = 6.2;
export const REACTION = 0.4;
const LINER_REACTION = 0.55;
const REACH = 1.5;
/** Release speed of a throw (m/s); air drag slows it down at THROW_DRAG per second. */
const THROW_SPEED = 34;
const THROW_DRAG = 0.15;
/** Outfielders throw at this fraction of an infielder's release speed. */
const OUTFIELD_ARM = 0.9;
const TRANSFER = 0.7;
const PICKUP = 0.5;
const PIVOT = 0.7;
const GROUND_SPEED_FACTOR = 0.72;
const GROUND_DECEL = 6;
const ROLL_MAX = 25;

export const RUN_TO_FIRST = 4.1;
export const RUN_PER_BASE = 3.7;
const LEAD_TO_SECOND = 3.3;
/** On a bunt the runners break with the contact, so the force at second is harder to get. */
const BUNT_LEAD_TO_SECOND = 2.75;
/** The catcher has to come out from his crouch (and lose the mask) to field a bunt. */
const CATCHER_BUNT_DELAY = 0.55;
const SAFE_MARGIN = 0.3;
const DEEP_HIT_DISTANCE = 85;
/** A tagging runner leaves the base this long after the catch. */
const TAG_START = 0.15;
/** A runner tags up when expected to beat the throw by more than this (seconds; negative = takes a risk). */
const TAG_GO: Record<number, number> = { 3: -0.15, 2: 0.3, 1: 0.6 };
/** Throws longer than this go through a cutoff man standing RELAY_POINT of the way along the line. */
const RELAY_MIN_DIST = 55;
const RELAY_POINT = 0.45;
const RELAY_TRANSFER = 0.35;
/** On a hit, a runner trying to score gets this head start (seconds), by bases to go: lead plus momentum. */
const RUNNER_JUMP: Record<number, number> = { 2: 0, 3: 1.4 };
/** A runner is sent home when expected to beat the throw by more than this (negative = takes a risk). */
const SEND_GO = -0.15;
/** Chance that the fielder making the play boots it. */
const ERROR_RATE = 0.02;
const FUMBLE_DIST = 3;
const FUMBLE_ROLL_SEC = 0.5;
const BOBBLE_SEC = 1.2;

export interface Throw {
  from: Vec2;
  to: Vec2;
  startSec: number;
  arriveSec: number;
  /** The fielder runs the ball to the base instead of throwing it. */
  carried?: boolean;
  /** Release speed in m/s (thrown balls only). */
  speed?: number;
}

/** Everything needed to animate (and replay) a ball in play. Times are in game seconds. */
export interface BallTrack {
  kind: 'air' | 'ground';
  direction: Vec2;
  /** Air: landing spot. Ground: unused (equals fieldAt). */
  landing: Vec2;
  hangSec: number;
  peakM: number;
  groundV0: number;
  groundDecel: number;
  groundMaxDist: number;
  /** Fielder who makes the play, -1 for a home run. */
  fielder: number;
  fielderArriveSec: number;
  fieldAt: Vec2;
  fieldSec: number;
  throws: Throw[];
  /** Bases the batter reaches (0 when out, 4 for a home run). */
  batterBases: number;
  /** On an error: where the ball squirts away to before the fielder recovers it. */
  fumbleAt?: Vec2;
}

/** What one runner (or the batter) does on the play. The rules apply these as-is. */
export interface RunnerMove {
  /** 0 = the batter, 1-3 = the base the runner started on. */
  from: number;
  /** Base the runner ends on (4 = scored). For an out, the base the runner was heading to. */
  to: number;
  out: boolean;
  /** 'tagUp' waits on the base for the catch; 'hold' takes a lead and goes back. */
  action: 'run' | 'tagUp' | 'hold';
  /** When the runner leaves the base (game seconds after contact). */
  startSec: number;
  /** When the runner is put out (outs only). */
  outSec: number;
  /** When the runner reaches `to`, if quicker than the normal pace (e.g. with a running start). */
  arriveSec?: number;
}

/** When a runner reaches (or, if out, would have reached) the base he is heading to. */
export function runnerArriveSec(r: RunnerMove): number {
  if (r.arriveSec !== undefined) return r.arriveSec;
  if (r.from === 0) return r.to > 0 ? RUN_TO_FIRST + RUN_PER_BASE * (r.to - 1) : 0;
  return r.startSec + RUN_PER_BASE * (r.to - r.from);
}

/** Any runner the ball beats to his base is out there, the moment it arrives. */
function throwsBeatRunners(runners: RunnerMove[], throws: Throw[]): RunnerMove[] {
  return runners.map((r) => {
    if (r.out || r.action === 'hold' || r.to === r.from) return r;
    const arrive = runnerArriveSec(r);
    const beat = throws.find((th) => distance(th.to, BASES[r.to % 4]!) < 0.01 && th.arriveSec <= arrive);
    return beat ? { ...r, out: true, outSec: beat.arriveSec } : r;
  });
}

export interface FieldingPlay {
  result: BipResult;
  fielder: number;
  /** Deep enough to score a runner from first on a double. */
  deep: boolean;
  distanceM: number;
  batted: BattedBall;
  track: BallTrack;
  runners: RunnerMove[];
}

type BallPlay = Omit<FieldingPlay, 'runners'>;

/** Animation of a foul ball: nobody makes a play and everyone goes back. */
export interface FoulPlay {
  result: 'foul';
  batted: BattedBall;
  track: BallTrack;
  runners: RunnerMove[];
}

/** Foul flies land in the stands or are given up on by this distance. */
const FOUL_MAX_CARRY = 80;
const FOUL_MAX_ROLL = 45;
/** How far foul territory reaches from the foul lines before the stands start. */
const FOUL_GROUND_M = 15;

/** Distance from the nearer foul line (field coordinates). */
function fromFoulLine(p: Vec2): number {
  return Math.min(Math.abs(p.x + p.y), Math.abs(p.y - p.x)) / Math.SQRT2;
}

/** A foul ball. A fly that a fielder reaches in foul ground before it lands is caught for an out. */
export function resolveFoulBall(ball: BattedBall, bases: Bases, outs: number): FoulPlay | FieldingPlay {
  const v = ball.exitVeloKmh / 3.6;
  const a = deg2rad(ball.launchDeg);
  const dir = direction(ball.sprayDeg);
  const nobody = { fielder: -1, fielderArriveSec: 0, throws: [], batterBases: 0 };
  let track: BallTrack;
  if (ball.launchDeg >= GROUND_LAUNCH_DEG) {
    const fullCarry = ((v * v * Math.sin(2 * a)) / G) * CARRY;
    const carry = Math.min(FOUL_MAX_CARRY, fullCarry);
    const hangSec = Math.max(0.6, ((2 * v * Math.sin(a)) / G) * HANG_FACTOR);
    const peakM = ((v * Math.sin(a)) ** 2 / (2 * G)) * PEAK_FACTOR;
    const landing = scale(dir, carry);
    track = { kind: 'air', direction: dir, landing, hangSec, peakM, groundV0: 0, groundDecel: 0, groundMaxDist: 0, ...nobody, fieldAt: landing, fieldSec: hangSec };
    if (fullCarry <= FOUL_MAX_CARRY && fromFoulLine(landing) <= FOUL_GROUND_M) {
      const catcher = nearestFielder(landing, REACTION, () => false);
      if (catcher.need <= hangSec) {
        const caught = { ...track, fielder: catcher.index, fielderArriveSec: catcher.need };
        return moveRunners({ result: 'foulout', fielder: catcher.index, deep: false, distanceM: carry, batted: ball, track: caught }, bases, outs);
      }
    }
  } else {
    const v0 = v * Math.cos(a) * GROUND_SPEED_FACTOR;
    const maxDist = Math.min((v0 * v0) / (2 * GROUND_DECEL), FOUL_MAX_ROLL);
    const rollSec = (v0 - Math.sqrt(Math.max(0, v0 * v0 - 2 * GROUND_DECEL * maxDist))) / GROUND_DECEL;
    const rest = scale(dir, maxDist);
    track = {
      kind: 'ground',
      direction: dir,
      landing: rest,
      hangSec: 0,
      peakM: 0,
      groundV0: v0,
      groundDecel: GROUND_DECEL,
      groundMaxDist: maxDist,
      ...nobody,
      fieldAt: rest,
      fieldSec: rollSec,
    };
  }
  const runners: RunnerMove[] = [0, 1, 2, 3]
    .filter((b) => b === 0 || bases[b - 1])
    .map((from) => ({ from, to: from, out: false, action: 'hold', startSec: 0, outSec: 0 }));
  return { result: 'foul', batted: ball, track, runners };
}

export function fenceDistance(sprayDeg: number): number {
  return 100 + 22 * Math.cos(deg2rad(sprayDeg * 2));
}

function direction(sprayDeg: number): Vec2 {
  const r = deg2rad(sprayDeg);
  return { x: Math.sin(r), y: Math.cos(r) };
}

const scale = (v: Vec2, s: number): Vec2 => ({ x: v.x * s, y: v.y * s });

function timeToReach(fielder: number, point: Vec2, reaction: number): number {
  return reaction + Math.max(0, distance(DEFAULT_FIELDERS[fielder]!, point) - REACH) / FIELDER_SPEED;
}

function nearestFielder(point: Vec2, reaction: number, skip: (i: number) => boolean): { index: number; need: number } {
  let index = -1;
  let need = Infinity;
  for (let i = 0; i < DEFAULT_FIELDERS.length; i++) {
    if (skip(i)) continue;
    const n = timeToReach(i, point, reaction);
    if (n < need) {
      need = n;
      index = i;
    }
  }
  return { index, need };
}

/** Flight time of a throw over `d` meters, with speed decaying as v0·e^(-kt). */
function throwSec(d: number, speed = THROW_SPEED): number {
  return -Math.log(Math.max(0.05, 1 - (THROW_DRAG * d) / speed)) / THROW_DRAG;
}

/** Distance a throw has covered `sec` seconds after release. */
function throwDistanceAt(sec: number, speed = THROW_SPEED): number {
  return (speed / THROW_DRAG) * (1 - Math.exp(-THROW_DRAG * sec));
}

function armOf(fielder: number): number {
  return fielder > LAST_INFIELDER ? THROW_SPEED * OUTFIELD_ARM : THROW_SPEED;
}

function throwBall(from: Vec2, to: Vec2, startSec: number, speed = THROW_SPEED): Throw {
  return { from, to, startSec, arriveSec: startSec + throwSec(distance(from, to), speed), speed };
}

/** A throw from `from` to `to`; long ones are caught by the cutoff man and relayed on. */
function throwPlan(from: Vec2, to: Vec2, startSec: number, speed: number): Throw[] {
  if (distance(from, to) < RELAY_MIN_DIST) return [throwBall(from, to, startSec, speed)];
  const cut = lerpVec(from, to, RELAY_POINT);
  const first = throwBall(from, cut, startSec, speed);
  return [first, throwBall(cut, to, first.arriveSec + RELAY_TRANSFER)];
}

const arrivalOf = (throws: Throw[]): number => throws[throws.length - 1]!.arriveSec;

/** How many bases the batter can take before a throw from `at` (released at `readySec`) beats him. */
function basesForHit(at: Vec2, readySec: number, maxBases: number, speed: number): number {
  for (let n = maxBases; n >= 2; n--) {
    const runner = RUN_TO_FIRST + RUN_PER_BASE * (n - 1);
    const throwArrive = arrivalOf(throwPlan(at, BASES[n]!, readySec + TRANSFER, speed));
    if (runner + SAFE_MARGIN < throwArrive) return n;
  }
  return 1;
}

const HIT_BY_BASES: Record<number, BipResult> = { 1: 'single', 2: 'double', 3: 'triple' };

/** Without `rng` there are no errors (useful for tests). */
export function resolveBattedBall(ball: BattedBall, bases: Bases, outs: number, rng?: Rng): FieldingPlay {
  const play = moveRunners(ball.launchDeg >= GROUND_LAUNCH_DEG ? resolveAirBall(ball) : resolveGroundBall(ball, bases, outs), bases, outs);
  return rng && play.fielder >= 0 && rng.chance(ERROR_RATE) ? fieldingError(play, bases) : play;
}

/**
 * The fielder boots the ball: it squirts away, the throw after recovering it is late, and everyone is
 * safe with an extra base (two for the batter on an outfielder's error that would have been an out).
 */
function fieldingError(play: FieldingPlay, bases: Bases): FieldingPlay {
  const { track } = play;
  const wasHit = track.batterBases > 0;
  const extra = play.fielder > LAST_INFIELDER ? 2 : 1;
  const batterTo = Math.min(4, wasHit ? track.batterBases + 1 : extra);
  const runners: RunnerMove[] = [{ from: 0, to: batterTo, out: false, action: 'run', startSec: 0, outSec: 0 }];
  for (const b of [1, 2, 3].filter((b) => bases[b - 1])) {
    const before = wasHit ? (play.runners.find((r) => r.from === b)?.to ?? b) : b;
    runners.push({ from: b, to: Math.min(4, Math.max(before + 1, b + extra)), out: false, action: 'run', startSec: 0, outSec: 0 });
  }

  const fumbleAt = { x: track.fieldAt.x + track.direction.x * FUMBLE_DIST, y: track.fieldAt.y + track.direction.y * FUMBLE_DIST };
  const target = BASES[batterTo % 4]!;
  const batterArrive = RUN_TO_FIRST + RUN_PER_BASE * (batterTo - 1);
  let start = track.fieldSec + BOBBLE_SEC;
  let throws = throwPlan(fumbleAt, target, start, armOf(play.fielder));
  // Too late either way: the throw lands just after the batter gets there.
  const early = batterArrive + 0.3 - arrivalOf(throws);
  if (early > 0) {
    start += early;
    throws = throwPlan(fumbleAt, target, start, armOf(play.fielder));
  }
  return { ...play, result: 'error', track: { ...track, fumbleAt, throws, batterBases: batterTo }, runners };
}

function moveRunners(play: BallPlay, bases: Bases, outs: number): FieldingPlay {
  const { result, track } = play;
  const runners: RunnerMove[] = [];
  const run = (from: number, to: number, extra: Partial<RunnerMove> = {}) =>
    runners.push({ from, to, out: false, action: 'run', startSec: 0, outSec: 0, ...extra });
  const outAt = (sec: number): Partial<RunnerMove> => ({ out: true, outSec: sec });
  const throwArrive = (i: number) => track.throws[i]?.arriveSec ?? track.fieldSec;
  const occupied = [1, 2, 3].filter((b) => bases[b - 1]);
  let throws = track.throws;

  switch (result) {
    case 'single':
    case 'double':
    case 'triple':
    case 'homerun': {
      run(0, track.batterBases);
      // The runner trying to score from second on a single (first on a double) is sent only when the
      // throw home, through the cutoff, should be beaten; the throw then goes home instead.
      const sendFrom = result === 'single' ? 2 : result === 'double' ? 1 : 0;
      for (const b of occupied) {
        if (b !== sendFrom) {
          run(b, result === 'single' && b === 1 ? 2 : 4);
          continue;
        }
        const home = throwPlan(track.fieldAt, BASES[0]!, track.fieldSec + PICKUP, armOf(track.fielder));
        const arriveSec = RUN_PER_BASE * (4 - b) - RUNNER_JUMP[4 - b]!;
        const margin = arrivalOf(home) - arriveSec;
        if (margin < SEND_GO) {
          run(b, 3);
          continue;
        }
        run(b, 4, { arriveSec, ...(margin <= 0 ? outAt(arrivalOf(home)) : {}) });
        throws = home;
      }
      break;
    }
    case 'groundout':
      run(0, 1, outAt(throwArrive(0)));
      for (const b of occupied) run(b, b + 1);
      break;
    case 'forceOut':
    case 'fieldersChoice':
    case 'doublePlay':
      run(0, 1, result === 'doublePlay' ? outAt(throwArrive(1)) : {});
      for (const b of occupied) run(b, b + 1, b === 1 ? outAt(throwArrive(0)) : {});
      break;
    default:
      run(0, 1, outAt(track.fieldSec));
      return tagUps(play, bases, outs, runners);
  }
  return { ...play, track: { ...track, throws }, runners: throwsBeatRunners(runners, throws) };
}

/**
 * After a catch in the outfield, runners decide whether to tag up. The throw goes to the lead runner,
 * who is out if it gets there first; the runners behind advance safely.
 */
function tagUps(play: BallPlay, bases: Bases, outs: number, runners: RunnerMove[]): FieldingPlay {
  const track = play.track;
  const canTag = outs < 2 && track.fielder > LAST_INFIELDER;
  const ready = track.fieldSec + TRANSFER;
  const arm = armOf(track.fielder);
  const runnerArrive = track.fieldSec + TAG_START + RUN_PER_BASE;
  let throwTo = -1;
  let aheadFree = true;
  for (const b of [3, 2, 1]) {
    if (!bases[b - 1]) {
      aheadFree = true;
      continue;
    }
    const target = b + 1;
    const arrive = arrivalOf(throwPlan(track.fieldAt, BASES[target % 4]!, ready, arm));
    if (!canTag || !aheadFree || arrive - runnerArrive < TAG_GO[b]!) {
      runners.push({ from: b, to: b, out: false, action: 'hold', startSec: 0, outSec: 0 });
      aheadFree = false;
      continue;
    }
    const lead = throwTo < 0;
    if (lead) throwTo = target;
    const out = lead && runnerArrive >= arrive;
    runners.push({ from: b, to: target, out, action: 'tagUp', startSec: track.fieldSec + TAG_START, outSec: out ? arrive : 0 });
    aheadFree = true;
  }
  const throws = throwTo < 0 ? track.throws : throwPlan(track.fieldAt, BASES[throwTo % 4]!, ready, arm);
  return { ...play, track: { ...track, throws }, runners };
}

function resolveAirBall(ball: BattedBall): BallPlay {
  const v = ball.exitVeloKmh / 3.6;
  const a = deg2rad(ball.launchDeg);
  const dir = direction(ball.sprayDeg);
  const carry = ((v * v * Math.sin(2 * a)) / G) * CARRY;
  const hangSec = Math.max(0.6, ((2 * v * Math.sin(a)) / G) * HANG_FACTOR);
  const peakM = ((v * Math.sin(a)) ** 2 / (2 * G)) * PEAK_FACTOR;
  const landing = scale(dir, carry);
  const fence = fenceDistance(ball.sprayDeg);
  const base = { kind: 'air' as const, direction: dir, landing, hangSec, peakM, groundV0: 0, groundDecel: 0, groundMaxDist: 0 };

  if (carry >= fence) {
    return {
      result: 'homerun',
      fielder: -1,
      deep: true,
      distanceM: carry,
      batted: ball,
      track: { ...base, fielder: -1, fielderArriveSec: 0, fieldAt: landing, fieldSec: hangSec, throws: [], batterBases: 4 },
    };
  }

  const reaction = ball.launchDeg < LINER_DEG ? LINER_REACTION : REACTION;
  const catcher = nearestFielder(landing, reaction, (i) => i === CATCHER && carry > 15);
  if (catcher.need <= hangSec) {
    const result: BipResult = ball.launchDeg >= POPUP_DEG ? 'popout' : ball.launchDeg < LINER_DEG ? 'lineout' : 'flyout';
    return {
      result,
      fielder: catcher.index,
      deep: false,
      distanceM: carry,
      batted: ball,
      track: { ...base, fielder: catcher.index, fielderArriveSec: catcher.need, fieldAt: landing, fieldSec: hangSec, throws: [], batterBases: 0 },
    };
  }

  // It drops: the ball bounces on and the nearest fielder has to chase it down.
  const groundSpeed = v * Math.cos(a) * 0.45;
  const restDist = Math.min(carry + Math.min(ROLL_MAX, groundSpeed * 1.2), fence - 2);
  const rest = scale(dir, restDist);
  const rollSec = (restDist - carry) / Math.max(4, groundSpeed * 0.6);
  const chaser = nearestFielder(rest, REACTION, (i) => i === CATCHER);
  const fieldSec = Math.max(chaser.need, hangSec + rollSec);
  const readySec = fieldSec + PICKUP;
  const arm = armOf(chaser.index);
  const batterBases = basesForHit(rest, readySec, 3, arm);
  return {
    result: HIT_BY_BASES[batterBases]!,
    fielder: chaser.index,
    deep: restDist >= DEEP_HIT_DISTANCE,
    distanceM: restDist,
    batted: ball,
    track: {
      ...base,
      fielder: chaser.index,
      fielderArriveSec: chaser.need,
      fieldAt: rest,
      fieldSec,
      throws: throwPlan(rest, BASES[(batterBases + 1) % 4]!, readySec, arm),
      batterBases,
    },
  };
}

function resolveGroundBall(ball: BattedBall, bases: Bases, outs: number): BallPlay {
  const v = ball.exitVeloKmh / 3.6;
  const a = deg2rad(ball.launchDeg);
  const dir = direction(ball.sprayDeg);
  const chopped = ball.launchDeg < -10 ? 0.75 : 1;
  const v0 = v * Math.cos(a) * GROUND_SPEED_FACTOR * chopped;
  const fence = fenceDistance(ball.sprayDeg);
  const stopSec = v0 / GROUND_DECEL;
  const maxDist = Math.min((v0 * stopSec) / 2, fence - 2);
  const distAt = (t: number) => (t >= stopSec ? maxDist : Math.min(maxDist, v0 * t - 0.5 * GROUND_DECEL * t * t));

  let fielder = -1;
  let fieldSec = 0;
  let fielderArriveSec = 0;
  let fieldAt: Vec2 = { x: 0, y: 0 };
  search: for (let t = 0.1; t < 30; t += 0.02) {
    const d = distAt(t);
    const p = scale(dir, d);
    for (let i = 0; i < DEFAULT_FIELDERS.length; i++) {
      if (i === CATCHER && d > 8) continue;
      const need = timeToReach(i, p, REACTION) + (ball.bunt && i === CATCHER ? CATCHER_BUNT_DELAY : 0);
      if (need <= t) {
        fielder = i;
        fieldSec = t;
        fielderArriveSec = need;
        fieldAt = p;
        break search;
      }
    }
  }

  const track: Omit<BallTrack, 'throws' | 'batterBases'> = {
    kind: 'ground',
    direction: dir,
    landing: fieldAt,
    hangSec: 0,
    peakM: 0,
    groundV0: v0,
    groundDecel: GROUND_DECEL,
    groundMaxDist: maxDist,
    fielder,
    fielderArriveSec,
    fieldAt,
    fieldSec,
  };
  const play = (result: BipResult, throws: Throw[], batterBases: number): BallPlay => ({
    result,
    fielder,
    deep: false,
    distanceM: distance(fieldAt, BASES[0]!),
    batted: ball,
    track: { ...track, throws, batterBases },
  });

  if (fielder > LAST_INFIELDER) {
    const readySec = fieldSec + PICKUP;
    const arm = armOf(fielder);
    const batterBases = basesForHit(fieldAt, readySec, 2, arm);
    return play(HIT_BY_BASES[batterBases]!, throwPlan(fieldAt, BASES[(batterBases + 1) % 4]!, readySec, arm), batterBases);
  }

  // Infielder: try for two if possible, otherwise go to first.
  if (bases[0] && outs < 2) {
    const toSecond = distance(fieldAt, BASES[2]!);
    const second: Throw =
      (fielder === 3 || fielder === 5) && toSecond < 5
        ? { from: fieldAt, to: BASES[2]!, startSec: fieldSec, arriveSec: fieldSec + toSecond / FIELDER_SPEED + 0.1, carried: true }
        : throwBall(fieldAt, BASES[2]!, fieldSec + TRANSFER);
    if (second.arriveSec < (ball.bunt ? BUNT_LEAD_TO_SECOND : LEAD_TO_SECOND)) {
      const relay = throwBall(BASES[2]!, BASES[1]!, second.arriveSec + PIVOT);
      return relay.arriveSec < RUN_TO_FIRST ? play('doublePlay', [second, relay], 0) : play('forceOut', [second], 1);
    }
  }

  const toFirst = distance(fieldAt, BASES[1]!);
  const first: Throw =
    fielder === FIRST_BASEMAN && toFirst < 12
      ? { from: fieldAt, to: BASES[1]!, startSec: fieldSec, arriveSec: fieldSec + toFirst / FIELDER_SPEED, carried: true }
      : throwBall(fieldAt, BASES[1]!, fieldSec + TRANSFER);
  return first.arriveSec < RUN_TO_FIRST ? play('groundout', [first], 0) : play('single', [first], 1);
}

export interface BallPosition {
  x: number;
  y: number;
  /** Height above the ground in meters. */
  h: number;
}

/** Ball position `t` game-seconds after contact. */
export function trackPositionAt(track: BallTrack, t: number): BallPosition {
  if (track.throws.length > 0 && t > track.fieldSec) {
    const first = track.throws[0]!;
    if (t < first.startSec) {
      if (!track.fumbleAt) return { ...track.fieldAt, h: 1.2 };
      // Booted: the ball pops out of the glove and rolls away until the fielder picks it up.
      const q = Math.min(1, (t - track.fieldSec) / FUMBLE_ROLL_SEC);
      return { ...lerpVec(track.fieldAt, track.fumbleAt, 1 - (1 - q) * (1 - q)), h: lerp(1.2, 0.1, q) };
    }
    for (const th of track.throws) {
      if (t <= th.arriveSec) {
        if (t < th.startSec) return { ...th.from, h: 1.2 };
        const d = distance(th.from, th.to);
        if (th.carried || d < 0.01) {
          const q = (t - th.startSec) / Math.max(0.01, th.arriveSec - th.startSec);
          return { ...lerpVec(th.from, th.to, q), h: 1.2 };
        }
        // Thrown balls slow down with drag; longer throws are lofted higher.
        const q = Math.min(1, throwDistanceAt(t - th.startSec, th.speed) / d);
        return { ...lerpVec(th.from, th.to, q), h: 1.2 + 4 * Math.min(6, d * 0.05) * q * (1 - q) };
      }
    }
    return { ...track.throws[track.throws.length - 1]!.to, h: 1.2 };
  }

  if (track.kind === 'ground') {
    const tt = Math.min(t, track.fieldSec);
    const stopSec = track.groundV0 / track.groundDecel;
    const d =
      tt >= stopSec
        ? track.groundMaxDist
        : Math.min(track.groundMaxDist, track.groundV0 * tt - 0.5 * track.groundDecel * tt * tt);
    return { x: track.direction.x * d, y: track.direction.y * d, h: 0.1 };
  }

  if (t <= track.hangSec) {
    const p = t / track.hangSec;
    return { x: track.landing.x * p, y: track.landing.y * p, h: lerp(1, 0, p) + 4 * track.peakM * p * (1 - p) };
  }
  if (track.fielder < 0 || track.fieldSec <= track.hangSec) {
    // Home run or a catch: the ball stays where it ended up.
    return { ...track.landing, h: track.fielder < 0 ? 0 : 1.5 };
  }
  const q = Math.min(1, (t - track.hangSec) / (track.fieldSec - track.hangSec));
  const eased = 1 - (1 - q) * (1 - q);
  return { ...lerpVec(track.landing, track.fieldAt, eased), h: 0.1 };
}
