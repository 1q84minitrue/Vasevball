import { BASES, clamp, DEFAULT_FIELDERS, distance, fenceDistance, FIELDER_SPEED, lerpVec, REACTION } from '@vaseball/core';
import type { Bases, FieldingPlay, FoulPlay, Vec2 } from '@vaseball/core';

// Scorebook position numbers minus one, matching DEFAULT_FIELDERS.
const P = 0;
const C = 1;
const FIRST = 2;
const SECOND = 3;
const THIRD = 4;
const SHORT = 5;
const LF = 6;
const CF = 7;
const RF = 8;
const OUTFIELDERS = [LF, CF, RF];
const MAX_SPEED = 9;

/** One run toward `to`, started no earlier than `start` (game seconds after contact). */
interface Leg {
  to: Vec2;
  start: number;
  speed: number;
}

const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (v: Vec2, s: number): Vec2 => ({ x: v.x * s, y: v.y * s });
const unit = (v: Vec2): Vec2 => scale(v, 1 / (Math.hypot(v.x, v.y) || 1));

function walk(home: Vec2, legs: Leg[], t: number): Vec2 {
  let pos = home;
  let clock = 0;
  for (const leg of legs) {
    const begin = Math.max(leg.start, clock);
    if (t <= begin) return pos;
    const dur = distance(pos, leg.to) / leg.speed;
    if (t < begin + dur) return lerpVec(pos, leg.to, (t - begin) / dur);
    pos = leg.to;
    clock = begin + dur;
  }
  return pos;
}

/** A point `d` meters further from home plate than `at`, kept inside the fence. */
function behind(at: Vec2, d: number): Vec2 {
  const dir = unit(at);
  const spray = (Math.atan2(dir.x, dir.y) * 180) / Math.PI;
  const r = Math.min(Math.hypot(at.x, at.y) + d, fenceDistance(clamp(spray, -45, 45)) - 3);
  return scale(dir, r);
}

function baseIndex(p: Vec2): number {
  return BASES.findIndex((b) => distance(b, p) < 0.01);
}

/**
 * Where every fielder runs on a ball in play, as in a real game: the fielder making the play goes to the
 * ball, throw receivers get to their base in time, and the rest cover bases, line up as the cutoff or back
 * up the play. Animation only; the outcome is already decided by core.
 */
function planFielders(play: FieldingPlay | FoulPlay, bases: Bases): Leg[][] {
  const track = play.track;
  const f = track.fielder;
  const ballAt = track.fieldAt;
  const legs: Leg[][] = DEFAULT_FIELDERS.map(() => []);
  if (play.result === 'foul') {
    // The nearest fielder gives chase into foul territory; the rest just react.
    const chaser = DEFAULT_FIELDERS.reduce((a, _, b) => (distance(DEFAULT_FIELDERS[b]!, ballAt) < distance(DEFAULT_FIELDERS[a]!, ballAt) ? b : a), 0);
    return DEFAULT_FIELDERS.map((home, i) =>
      i === chaser
        ? [{ to: ballAt, start: REACTION, speed: FIELDER_SPEED }]
        : [{ to: lerpVec(home, ballAt, Math.min(1, 3 / Math.max(1, distance(home, ballAt)))), start: REACTION, speed: FIELDER_SPEED * 0.6 }],
    );
  }
  const assigned = new Set<number>();
  const assign = (i: number, ...l: Leg[]) => {
    if (assigned.has(i)) return;
    assigned.add(i);
    legs[i] = l;
  };
  const run = (i: number, to: Vec2, arriveBy?: number): Leg => {
    const d = distance(DEFAULT_FIELDERS[i]!, to);
    const speed = arriveBy === undefined ? FIELDER_SPEED : clamp(d / Math.max(0.3, arriveBy - 0.1 - REACTION), FIELDER_SPEED, MAX_SPEED);
    return { to, start: REACTION, speed };
  };

  // The fielder making the play, who may then run the ball to the base.
  if (f >= 0) {
    const reach = distance(DEFAULT_FIELDERS[f]!, ballAt);
    const own: Leg[] = [{ to: ballAt, start: REACTION, speed: Math.max(FIELDER_SPEED * 0.5, reach / Math.max(0.05, track.fielderArriveSec - REACTION)) }];
    const first = track.throws[0];
    // On an error the fielder chases down the ball that got away.
    if (track.fumbleAt) own.push({ to: track.fumbleAt, start: track.fieldSec, speed: FIELDER_SPEED });
    if (first?.carried) {
      own.push({ to: first.to, start: first.startSec, speed: distance(first.from, first.to) / Math.max(0.01, first.arriveSec - first.startSec) });
    }
    assign(f, ...own);
  } else {
    // Home run: the nearest outfielder gives chase to the wall.
    const chaser = OUTFIELDERS.reduce((a, b) => (distance(DEFAULT_FIELDERS[b]!, ballAt) < distance(DEFAULT_FIELDERS[a]!, ballAt) ? b : a));
    assign(chaser, run(chaser, behind(ballAt, 0)));
  }

  const infield = f >= 0 && f <= SHORT;
  const leftSide = ballAt.x <= 0;
  const target = track.throws[track.throws.length - 1]?.to ?? BASES[2]!;
  // Throws home are cut off by the third baseman from left field and the first baseman otherwise;
  // throws to the bases by the shortstop (left side) or second baseman (right side).
  const homeThrow = !infield && baseIndex(target) === 0;
  const cutoff = homeThrow ? (ballAt.x < -15 ? THIRD : FIRST) : leftSide ? SHORT : SECOND;
  const coverer = (base: number): number => {
    switch (base) {
      case 1:
        if (f === FIRST) return P;
        return cutoff === FIRST ? SECOND : FIRST;
      case 2:
        if (infield) return f === THIRD || f === SHORT ? SECOND : SHORT;
        if (cutoff === FIRST) return SHORT;
        return leftSide ? SECOND : SHORT;
      case 3:
        return f === THIRD || cutoff === THIRD ? SHORT : THIRD;
      default:
        return f === C ? P : C;
    }
  };

  // Receivers must be in place before the ball gets there; a throw that ends off a base goes to the cutoff man.
  for (const th of track.throws) {
    if (th.carried) continue;
    const base = baseIndex(th.to);
    const r = base < 0 ? cutoff : coverer(base);
    assign(r, run(r, th.to, th.arriveSec));
  }

  if (infield) {
    assign(coverer(1), run(coverer(1), BASES[1]!));
    assign(coverer(2), run(coverer(2), BASES[2]!));
    if (bases.some(Boolean)) assign(coverer(3), run(coverer(3), BASES[3]!));
    if (track.kind === 'ground') {
      // The pitcher breaks toward first on balls to the right side.
      if (f === FIRST || f === SECOND) assign(P, run(P, { x: 12, y: 15 }));
      // With nobody in scoring position the catcher trails the runner to back up first.
      if (!bases[1] && !bases[2]) assign(C, run(C, { x: 16, y: 10 }));
      const backup = ballAt.x < -8 ? LF : ballAt.x > 8 ? RF : CF;
      assign(backup, run(backup, behind(ballAt, 14)));
      assign(RF, run(RF, { x: 30, y: 24 }));
    }
  } else {
    const chaser = f >= 0 ? f : -1;
    const others = OUTFIELDERS.filter((i) => i !== chaser && !assigned.has(i));
    if (others.length > 0) {
      const backup = others.reduce((a, b) => (distance(DEFAULT_FIELDERS[b]!, ballAt) < distance(DEFAULT_FIELDERS[a]!, ballAt) ? b : a));
      assign(backup, run(backup, behind(ballAt, 8)));
    }
    assign(cutoff, run(cutoff, lerpVec(ballAt, target, 0.45)));
    for (const base of [1, 2, 3]) assign(coverer(base), run(coverer(base), BASES[base]!));
    // The pitcher backs up the base the ball is coming to.
    assign(P, run(P, add(target, scale(unit(sub(target, ballAt)), 8))));
    assign(C, run(C, BASES[0]!));
  }

  // Everyone else takes a few steps toward the ball.
  DEFAULT_FIELDERS.forEach((home, i) => {
    const gap = distance(home, ballAt);
    assign(i, { to: lerpVec(home, ballAt, Math.min(1, 3 / Math.max(1, gap))), start: REACTION, speed: FIELDER_SPEED * 0.6 });
  });
  return legs;
}

const plans = new WeakMap<FieldingPlay | FoulPlay, Leg[][]>();

/** Fielder positions `t` game-seconds after contact. */
export function fielderPositions(play: FieldingPlay | FoulPlay, bases: Bases, t: number): Vec2[] {
  let plan = plans.get(play);
  if (!plan) {
    plan = planFielders(play, bases);
    plans.set(play, plan);
  }
  return DEFAULT_FIELDERS.map((home, i) => walk(home, plan[i]!, t));
}
