import { describe, expect, it } from 'vitest';
import {
  applyPitchEvent,
  baseCalls,
  BAT_TYPES,
  chargeRequest,
  createGame,
  createPitch,
  isWrongCall,
  makeTeam,
  overturnCall,
  requestableCall,
  resolveBattedBall,
  resolveSwing,
  reviewCall,
  Rng,
  umpireCalls,
  withCalls,
  type FieldingPlay,
  type GameState,
  type Pitch,
  type PitchEvent,
} from '../src';

const teams = { away: makeTeam('A', 'A'), home: makeTeam('H', 'H', 9) };
const pitchAt = (x: number, y: number, type: Pitch['type'] = 'fastball'): Pitch => ({
  ...createPitch({ type, target: { x: 0, y: 0 } }, new Rng(1)),
  plate: { x, y },
});

describe('hit by pitch', () => {
  it('a fastball to the head gets the pitcher ejected', () => {
    const out = resolveSwing(pitchAt(-3, 3), { swing: false }, new Rng(1));
    expect(out).toEqual({ kind: 'hitByPitch', head: true, dangerous: true });
    const r = applyPitchEvent(createGame(teams), out as PitchEvent);
    expect(r.messages).toContain('危険球退場! ピッチャー交代');
    expect(r.state.bases).toEqual([true, false, false]);
  });

  it('a breaking ball to the head warns the benches, and the next one is an ejection', () => {
    const out = resolveSwing(pitchAt(-3, 3, 'curve'), { swing: false }, new Rng(1)) as PitchEvent;
    const first = applyPitchEvent(createGame(teams), out);
    expect(first.messages).toContain('警告試合が宣告されました');
    expect(applyPitchEvent(first.state, out).messages).toContain('危険球退場! ピッチャー交代');
  });

  it('a pitch high and wide of the head is just a ball', () => {
    expect(resolveSwing(pitchAt(-1.5, 3.4), { swing: false }, new Rng(1)).kind).toBe('ball');
  });
});

describe('bunts', () => {
  const bunt = (aimY: number, seed: number) =>
    resolveSwing(pitchAt(0, 0), { swing: true, bunt: true, timeMs: 0, aim: { x: 0, y: aimY } }, new Rng(seed));

  it('a square bunt is a slow ball on the ground or a foul', () => {
    for (let seed = 0; seed < 50; seed++) {
      const out = bunt(0, seed);
      expect(['inPlay', 'foul']).toContain(out.kind);
      if (out.kind === 'inPlay') {
        expect(out.ball.exitVeloKmh).toBeLessThan(75);
        expect(out.ball.launchDeg).toBeLessThan(10);
      }
    }
  });

  it('misses when the bat is nowhere near the ball', () => {
    expect(bunt(1.5, 1).kind).toBe('swingingStrike');
  });

  it('usually moves the runner over', () => {
    let sacrifices = 0;
    for (let seed = 0; seed < 40; seed++) {
      const play = resolveBattedBall({ exitVeloKmh: 40, launchDeg: -14, sprayDeg: (seed % 9) * 8 - 32, quality: 0.8, bunt: true }, [true, false, false], 0);
      if (play.result === 'groundout') sacrifices++;
    }
    expect(sacrifices).toBeGreaterThan(20);
  });

  it('a two-strike bunt foul is a strikeout', () => {
    const s: GameState = { ...createGame(teams), strikes: 2 };
    const r = applyPitchEvent(s, { kind: 'foul', bunt: true });
    expect(r.state.outs).toBe(1);
    expect(r.messages).toContain('スリーバント失敗');
  });
});

describe('bats', () => {
  it('every bat can hit a ball squarely', () => {
    for (const bat of BAT_TYPES) {
      const kinds = new Set<string>();
      for (let seed = 0; seed < 30; seed++) {
        const p = pitchAt(0, 0);
        kinds.add(resolveSwing(p, { swing: true, timeMs: p.flightMs, aim: { x: 0, y: 0 } }, new Rng(seed), bat).kind);
      }
      expect(kinds.has('inPlay')).toBe(true);
    }
  });

  it('the frying pan reaches pitches the bat misses', () => {
    const p = pitchAt(0.7, 0);
    const swing = { swing: true as const, timeMs: p.flightMs, aim: { x: 0, y: 0 } };
    expect(resolveSwing(p, swing, new Rng(1), 'normal').kind).toBe('swingingStrike');
    expect(resolveSwing(p, swing, new Rng(1), 'fryingPan').kind).not.toBe('swingingStrike');
  });
});

describe('umpires and replay review', () => {
  const groundout = (): FieldingPlay => {
    const play = resolveBattedBall({ exitVeloKmh: 120, launchDeg: -5, sprayDeg: -20, quality: 0.7 }, [false, false, false], 0);
    expect(play.result).toBe('groundout');
    return play;
  };

  it('the throw to first is a call', () => {
    const calls = baseCalls(groundout());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ base: 1, out: true, calledOut: true });
    expect(calls[0]!.gap).toBeLessThan(0);
  });

  it('base umpires miss about 5% of calls', () => {
    const truth = groundout();
    const rng = new Rng(7);
    let wrong = 0;
    for (let i = 0; i < 4000; i++) if (umpireCalls(truth, rng).calls.some(isWrongCall)) wrong++;
    expect(wrong / 4000).toBeGreaterThan(0.04);
    expect(wrong / 4000).toBeLessThan(0.06);
  });

  it('a batter wrongly called safe gets an infield hit, and review puts it right', () => {
    const truth = groundout();
    const calls = baseCalls(truth).map((c) => ({ ...c, calledOut: false }));
    const called = withCalls(truth, calls);
    expect(called.result).toBe('single');
    expect(applyPitchEvent(createGame(teams), { kind: 'inPlay', play: called }).state.bases).toEqual([true, false, false]);

    const call = requestableCall(calls, false)!;
    expect(call).toBeDefined();
    expect(requestableCall(calls, true)).toBeNull();
    expect(reviewCall(call, new Rng(1))).toBe(true);
    const fixed = overturnCall(truth, calls, call);
    expect(fixed.play.result).toBe('groundout');
  });

  it('a correct call stands, and the request is used up', () => {
    const truth = groundout();
    const call = requestableCall(baseCalls(truth), true)!;
    expect(reviewCall(call, new Rng(1))).toBe(false);
    const s = chargeRequest(createGame(teams), 'away', false);
    expect(s.requestsLeft.away).toBe(1);
    expect(chargeRequest(s, 'away', true).requestsLeft.away).toBe(1);
  });

  it('extra innings come with one fresh request', () => {
    const strike: PitchEvent = { kind: 'calledStrike' };
    let s = { ...createGame(teams, 1), requestsLeft: { away: 0, home: 2 } };
    for (let i = 0; i < 18; i++) s = applyPitchEvent(s, strike).state;
    expect(s.inning).toBe(2);
    expect(s.requestsLeft).toEqual({ away: 1, home: 1 });
  });
});
