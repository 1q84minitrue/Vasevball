import { describe, expect, it } from 'vitest';
import {
  applyPitchEvent,
  botChoosePitch,
  botDecideSwing,
  createGame,
  createPitch,
  makeTeam,
  resolvePitchEvent,
  Rng,
  type BotLevel,
  type GameState,
} from '../src';

interface Stats {
  games: number;
  pa: number;
  ab: number;
  hits: Record<string, number>;
  walks: number;
  hbp: number;
  strikeouts: number;
  runs: number;
  pitches: number;
  swings: number;
  contacts: number;
}

function simulate(seed: number, games: number, level: BotLevel = 'normal') {
  const stats: Stats = { games, pa: 0, ab: 0, hits: {}, walks: 0, hbp: 0, strikeouts: 0, runs: 0, pitches: 0, swings: 0, contacts: 0 };
  const finals: GameState[] = [];
  for (let g = 0; g < games; g++) {
    const rng = new Rng(seed + g);
    const botRng = new Rng((seed + g) ^ 0x9e3779b9);
    let s = createGame({ away: makeTeam('A', 'A'), home: makeTeam('H', 'H', 9) }, 9);
    for (let guard = 0; s.status === 'playing' && guard < 5000; guard++) {
      const pitch = createPitch(botChoosePitch(s, botRng, level), rng);
      const swing = botDecideSwing(s, pitch, botRng, level);
      const ev = resolvePitchEvent(s, pitch, swing, rng);
      const report = applyPitchEvent(s, ev);
      stats.pitches++;
      if (swing.swing) stats.swings++;
      if (ev.kind === 'foul' || ev.kind === 'inPlay') stats.contacts++;
      if (report.paEnded) {
        stats.pa++;
        if (ev.kind === 'ball') stats.walks++;
        else if (ev.kind === 'hitByPitch') stats.hbp++;
        else stats.ab++;
        if (ev.kind === 'calledStrike' || ev.kind === 'swingingStrike') stats.strikeouts++;
        if (ev.kind === 'inPlay') stats.hits[ev.play.result] = (stats.hits[ev.play.result] ?? 0) + 1;
      }
      s = report.state;
    }
    stats.runs += s.runs.away + s.runs.home;
    finals.push(s);
  }
  return { stats, finals };
}

describe('bot vs bot simulation', () => {
  it('is deterministic for a given seed', () => {
    const a = simulate(42, 3).finals.map((s) => s.runs);
    const b = simulate(42, 3).finals.map((s) => s.runs);
    expect(a).toEqual(b);
  });

  it('produces plausible baseball stats', () => {
    const { stats, finals } = simulate(1, 200);
    const h = stats.hits;
    const hitCount = (h.single ?? 0) + (h.double ?? 0) + (h.triple ?? 0) + (h.homerun ?? 0);
    const avg = hitCount / stats.ab;
    const runsPerGame = stats.runs / stats.games / 2;
    const hrPerGame = (h.homerun ?? 0) / stats.games / 2;
    const kRate = stats.strikeouts / stats.pa;
    const bbRate = stats.walks / stats.pa;

    console.log(
      [
        `AVG ${avg.toFixed(3)}  R/G(team) ${runsPerGame.toFixed(2)}  HR/G(team) ${hrPerGame.toFixed(2)}`,
        `K% ${(kRate * 100).toFixed(1)}  BB% ${(bbRate * 100).toFixed(1)}  HBP% ${((stats.hbp / stats.pa) * 100).toFixed(1)}  P/PA ${(stats.pitches / stats.pa).toFixed(2)}  contact% ${((stats.contacts / stats.swings) * 100).toFixed(1)}`,
        `results ${JSON.stringify(h)}`,
        `finished ${finals.filter((s) => s.status === 'final').length}/${finals.length}`,
      ].join('\n'),
    );

    expect(finals.every((s) => s.status === 'final')).toBe(true);
    expect(avg).toBeGreaterThan(0.2);
    expect(avg).toBeLessThan(0.33);
    expect(runsPerGame).toBeGreaterThan(2);
    expect(runsPerGame).toBeLessThan(7);
    expect(kRate).toBeGreaterThan(0.1);
    expect(kRate).toBeLessThan(0.35);
    expect(bbRate).toBeLessThan(0.15);
  });
});
