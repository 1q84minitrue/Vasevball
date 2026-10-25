import { describe, expect, it } from 'vitest';
import { applyPitchEvent, createGame, makeTeam, resolveBattedBall, type GameState, type PitchEvent } from '../src';

const teams = { away: makeTeam('A', 'A'), home: makeTeam('H', 'H', 9) };

function apply(state: GameState, ...events: PitchEvent[]): GameState {
  return events.reduce((s, ev) => applyPitchEvent(s, ev).state, state);
}

const ball: PitchEvent = { kind: 'ball' };
const strike: PitchEvent = { kind: 'calledStrike' };
const strikeout = [strike, strike, strike];
const walk = [ball, ball, ball, ball];

describe('count and plate appearances', () => {
  it('walks force runners and score with the bases loaded', () => {
    const s = apply(createGame(teams), ...walk, ...walk, ...walk, ...walk);
    expect(s.bases).toEqual([true, true, true]);
    expect(s.runs.away).toBe(1);
    expect(s.lineScore.away).toEqual([1]);
    expect(s.batterIndex.away).toBe(4);
  });

  it('a hit by pitch sends the batter to first and forces runners', () => {
    const s = apply(createGame(teams), ...walk, { kind: 'hitByPitch' });
    expect(s.bases).toEqual([true, true, false]);
    expect(s.batterIndex.away).toBe(2);
  });

  it('fouls do not add a third strike', () => {
    const s = apply(createGame(teams), strike, strike, { kind: 'foul' }, { kind: 'foul' });
    expect(s.strikes).toBe(2);
    expect(s.outs).toBe(0);
  });

  it('three outs switch sides and clear the bases', () => {
    const s = apply(createGame(teams), ...walk, ...strikeout, ...strikeout, ...strikeout);
    expect(s.half).toBe('bottom');
    expect(s.outs).toBe(0);
    expect(s.bases).toEqual([false, false, false]);
  });
});

describe('tag-ups', () => {
  const withRunnerOnThird = (outs: number): GameState => ({ ...createGame(teams), bases: [false, false, true], outs });
  const fly = (exitVeloKmh: number, launchDeg = 35) => ({ exitVeloKmh, launchDeg, sprayDeg: 0, quality: 1 });

  it('scores the runner from third on a deep fly', () => {
    const s = withRunnerOnThird(0);
    const play = resolveBattedBall(fly(150), s.bases, s.outs);
    expect(play.result).toBe('flyout');
    const r = applyPitchEvent(s, { kind: 'inPlay', play });
    expect(r.state.runs.away).toBe(1);
    expect(r.state.bases).toEqual([false, false, false]);
    expect(r.state.outs).toBe(1);
    expect(r.messages[0]).toContain('犠牲フライ');
  });

  it('holds the runner on a shallow fly', () => {
    const s = withRunnerOnThird(0);
    const play = resolveBattedBall(fly(135, 65), s.bases, s.outs);
    expect(play.fielder).toBe(7);
    expect(play.runners.find((r) => r.from === 0)?.out).toBe(true);
    expect(play.runners.find((r) => r.from === 3)?.action).toBe('hold');
    expect(applyPitchEvent(s, { kind: 'inPlay', play }).state.bases).toEqual([false, false, true]);
  });

  it('does not tag up with two outs', () => {
    const s = withRunnerOnThird(2);
    const play = resolveBattedBall(fly(150), s.bases, s.outs);
    expect(play.runners.every((r) => r.action !== 'tagUp')).toBe(true);
  });
});

describe('game end', () => {
  it('skips the bottom of the last inning when the home team leads', () => {
    let s = createGame(teams, 1);
    s = apply(s, ...strikeout, ...strikeout, ...strikeout); // top 1st: 0 runs
    s = apply(s, ...walk, ...walk, ...walk, ...walk); // bottom 1st: walk-off
    expect(s.status).toBe('final');
    expect(s.winner).toBe('home');
    expect(s.runs.home).toBe(1);
  });

  it('goes to extra innings when tied', () => {
    let s = createGame(teams, 1);
    for (let i = 0; i < 6; i++) s = apply(s, ...strikeout);
    expect(s.status).toBe('playing');
    expect(s.inning).toBe(2);
  });

  it('calls a tie after the max inning', () => {
    let s = createGame(teams, 1);
    for (let i = 0; i < 6 * s.config.maxInnings; i++) s = apply(s, ...strikeout);
    expect(s.status).toBe('final');
    expect(s.winner).toBe('tie');
  });
});
