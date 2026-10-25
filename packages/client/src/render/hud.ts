import { battingSide, currentBatter, inningLabel, PITCH_SPECS, TIMING_WINDOW_MS } from '@vaseball/core';
import type { GameState, Side } from '@vaseball/core';
import type { InputState } from '../game/input';
import type { GameSession, Phase } from '../game/session';
import { circle, drawText, panel, TEAM_COLORS, VIEW_H, VIEW_W, type Ctx } from './common';

function drawScoreboard(ctx: Ctx, s: GameState): void {
  const n = Math.max(s.config.innings, s.inning);
  const nameW = 50;
  const colW = 20;
  const rhW = 28;
  const x = 10;
  const y = 10;
  const w = nameW + n * colW + rhW * 2 + 10;
  panel(ctx, x, y, w, 64);

  const muted = 'rgba(255,255,255,0.55)';
  for (let i = 0; i < n; i++) {
    drawText(ctx, String(i + 1), x + nameW + i * colW + colW / 2, y + 16, { size: 10, color: muted, align: 'center' });
  }
  drawText(ctx, 'R', x + nameW + n * colW + rhW / 2, y + 16, { size: 10, color: muted, align: 'center' });
  drawText(ctx, 'H', x + nameW + n * colW + rhW * 1.5, y + 16, { size: 10, color: muted, align: 'center' });

  (['away', 'home'] as Side[]).forEach((side, row) => {
    const ry = y + 36 + row * 20;
    ctx.fillStyle = TEAM_COLORS[side];
    ctx.fillRect(x + 8, ry - 11, 4, 14);
    drawText(ctx, s.teams[side].short, x + 16, ry, { size: 12, weight: 700 });
    for (let i = 0; i < n; i++) {
      const v = s.lineScore[side][i];
      const skipped = side === 'home' && s.status === 'final' && v === undefined && i === n - 1;
      const text = v !== undefined ? String(v) : skipped ? 'X' : '';
      drawText(ctx, text, x + nameW + i * colW + colW / 2, ry, { size: 12, align: 'center' });
    }
    drawText(ctx, String(s.runs[side]), x + nameW + n * colW + rhW / 2, ry, { size: 13, align: 'center', weight: 800, color: '#ffd640' });
    drawText(ctx, String(s.hits[side]), x + nameW + n * colW + rhW * 1.5, ry, { size: 12, align: 'center' });
  });
}

function drawDots(ctx: Ctx, x: number, y: number, label: string, count: number, max: number, color: string): void {
  drawText(ctx, label, x, y + 4, { size: 12, weight: 800, color: 'rgba(255,255,255,0.8)' });
  for (let i = 0; i < max; i++) circle(ctx, x + 20 + i * 15, y, 5, i < count ? color : '#363e54');
}

function drawCount(ctx: Ctx, s: GameState): void {
  const w = 176;
  const x = VIEW_W - w - 10;
  const y = 10;
  panel(ctx, x, y, w, 88);
  drawText(ctx, inningLabel(s), x + 12, y + 22, { size: 15, weight: 800 });
  drawDots(ctx, x + 12, y + 40, 'B', s.balls, 3, '#3ddc84');
  drawDots(ctx, x + 12, y + 58, 'S', s.strikes, 2, '#ffd23f');
  drawDots(ctx, x + 12, y + 76, 'O', s.outs, 2, '#ff5a5a');

  const cx = x + 134;
  const cy = y + 52;
  const offsets: [number, number][] = [
    [16, 0],
    [0, -16],
    [-16, 0],
  ];
  offsets.forEach(([dx, dy], i) => {
    ctx.save();
    ctx.translate(cx + dx, cy + dy);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = s.bases[i] ? '#ffd640' : '#363e54';
    ctx.fillRect(-6, -6, 12, 12);
    ctx.restore();
  });
}

function drawBatterInfo(ctx: Ctx, s: GameState, humanSide: Side): void {
  const side = battingSide(s);
  const batter = currentBatter(s);
  panel(ctx, 10, VIEW_H - 58, 190, 48);
  ctx.fillStyle = TEAM_COLORS[side];
  ctx.fillRect(18, VIEW_H - 50, 4, 32);
  drawText(ctx, side === humanSide ? 'あなたの攻撃' : 'CPUの攻撃', 30, VIEW_H - 38, { size: 11, color: 'rgba(255,255,255,0.65)' });
  drawText(ctx, `${batter.order}番 ${batter.name}`, 30, VIEW_H - 18, { size: 16, weight: 800 });
}

function drawPitchInfo(ctx: Ctx, phase: Phase, input: InputState, now: number): void {
  let label: string | null = null;
  if (phase.kind === 'aiming' && phase.humanPitching) label = `球種: ${PITCH_SPECS[input.pitchType].label}`;
  else if (phase.kind === 'pitch' && now >= phase.releaseAt) label = `${PITCH_SPECS[phase.pitch.type].label}  ${phase.pitch.speedKmh}km/h`;
  else if (phase.kind === 'result') label = `${PITCH_SPECS[phase.pitch.type].label}  ${phase.pitch.speedKmh}km/h`;
  if (!label) return;
  panel(ctx, VIEW_W - 220, VIEW_H - 48, 210, 38);
  drawText(ctx, label, VIEW_W - 115, VIEW_H - 23, { size: 15, weight: 700, align: 'center' });
}

function hintFor(phase: Phase): string | null {
  if (phase.kind === 'aiming' && phase.humanPitching) return '1〜5: 球種 ／ マウス・矢印: コース ／ クリック・Space: 投げる';
  if ((phase.kind === 'aiming' || phase.kind === 'pitch') && phase.humanBatting) {
    return 'マウス・矢印: ミート位置 ／ クリック・Space: スイング';
  }
  return null;
}

function centerLines(ctx: Ctx, lines: string[], y: number): void {
  lines.forEach((line, i) => {
    drawText(ctx, line, VIEW_W / 2, y + i * 38, {
      size: i === 0 ? 34 : 24,
      align: 'center',
      weight: 800,
      outline: 7,
      color: i === 0 ? '#fff' : '#ffd640',
    });
  });
}

function timingFeedback(phase: Extract<Phase, { kind: 'result' }>): string | null {
  if (!phase.humanBatting || !phase.swing.swing) return null;
  const dt = Math.round(phase.swing.timeMs - phase.pitch.flightMs);
  const word = Math.abs(dt) <= 25 ? 'ジャスト!' : dt < 0 ? '早い' : '遅い';
  const tooFar = Math.abs(dt) > TIMING_WINDOW_MS ? 'すぎ' : '';
  return `タイミング ${dt > 0 ? '+' : ''}${dt}ms (${word}${word === 'ジャスト!' ? '' : tooFar})`;
}

export function drawHud(ctx: Ctx, session: GameSession, input: InputState, now: number): void {
  const phase = session.phase;
  const state = phase.kind === 'inPlay' ? phase.before : session.state;
  drawScoreboard(ctx, state);
  drawCount(ctx, state);
  if (phase.kind === 'inPlay') return;

  drawBatterInfo(ctx, state, session.humanSide);
  drawPitchInfo(ctx, phase, input, now);

  const hint = hintFor(phase);
  if (hint) drawText(ctx, hint, VIEW_W / 2, VIEW_H - 70, { size: 13, align: 'center', outline: 4, color: 'rgba(255,255,255,0.9)' });

  if (phase.kind === 'result') {
    centerLines(ctx, phase.messages, 140);
    const fb = timingFeedback(phase);
    if (fb) drawText(ctx, fb, VIEW_W / 2, 136 + phase.messages.length * 38, { size: 16, align: 'center', outline: 4, color: '#8cdcff' });
  } else if (phase.kind === 'change') {
    centerLines(ctx, [phase.text], 200);
  } else if (phase.kind === 'final') {
    centerLines(ctx, ['ゲームセット'], 200);
  } else if (phase.kind === 'aiming' && !phase.humanPitching && phase.humanBatting) {
    drawText(ctx, 'ピッチャー構えて…', VIEW_W / 2, 150, { size: 16, align: 'center', outline: 4, color: 'rgba(255,255,255,0.75)' });
  }
}
