import {
  BASES,
  battingSide,
  clamp,
  FIELDER_LABELS,
  fenceDistance,
  fieldingSide,
  lerpVec,
  runnerArriveSec,
  RUN_PER_BASE,
  RUN_TO_FIRST,
  trackPositionAt,
} from '@vaseball/core';
import type { BaseCall, Bases, FieldingPlay, FoulPlay, RunnerMove, Vec2 } from '@vaseball/core';
import {
  ASCEND_SEC,
  PLAY_SPEED,
  REPLAY_LEAD_SEC,
  REPLAY_SPEED,
  REPLAY_TAIL_SEC,
  resultShownSec,
  type InPlayPhase,
  type ReviewPhase,
} from '../game/session';
import { circle, drawText, TEAM_COLORS, VIEW_H, VIEW_W, type Ctx } from './common';
import { fielderPositions } from './fielderMotion';

// Top-down field: meters → pixels.
const FS = 3.4;
const HX = VIEW_W / 2;
const HY = 575;
const fp = (v: Vec2) => ({ x: HX + v.x * FS, y: HY - v.y * FS });

const GRASS = '#2f7a3a';
const DIRT = '#b5835a';

function fencePoints(inset = 0): Vec2[] {
  const pts: Vec2[] = [];
  for (let a = -45; a <= 45; a += 3) {
    const d = fenceDistance(a) - inset;
    const r = (a * Math.PI) / 180;
    pts.push({ x: Math.sin(r) * d, y: Math.cos(r) * d });
  }
  return pts;
}

function tracePolygon(ctx: Ctx, pts: Vec2[]): void {
  ctx.beginPath();
  pts.forEach((v, i) => {
    const p = fp(v);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
}

/** Static field, drawn once into an offscreen cache. */
export function drawFieldBackground(ctx: Ctx): void {
  ctx.fillStyle = '#121a2d';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  circle(ctx, HX, HY, 136 * FS, '#1c2640');
  circle(ctx, HX, HY, 128 * FS, '#26592f');

  const fair = [{ x: 0, y: -2 }, ...fencePoints()];
  tracePolygon(ctx, fair);
  ctx.fillStyle = GRASS;
  ctx.fill();

  ctx.save();
  tracePolygon(ctx, fair);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 8 * FS * 0.5;
  for (let r = 10; r < 130; r += 8) {
    ctx.beginPath();
    ctx.arc(HX, HY, r * FS, 0, Math.PI * 2);
    ctx.stroke();
  }
  const mound = fp({ x: 0, y: 18.44 });
  circle(ctx, mound.x, mound.y, 29 * FS, DIRT);
  ctx.restore();

  ctx.beginPath();
  fencePoints(2).forEach((v, i) => {
    const p = fp(v);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.strokeStyle = '#8a6a48';
  ctx.lineWidth = 4 * FS;
  ctx.stroke();
  ctx.beginPath();
  fencePoints().forEach((v, i) => {
    const p = fp(v);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.strokeStyle = '#e8c547';
  ctx.lineWidth = 2;
  ctx.stroke();

  tracePolygon(ctx, [
    { x: 0, y: 3 },
    { x: 16.4, y: 19.4 },
    { x: 0, y: 35.8 },
    { x: -16.4, y: 19.4 },
  ]);
  ctx.fillStyle = GRASS;
  ctx.fill();
  circle(ctx, mound.x, mound.y, 2.7 * FS, DIRT);
  const home = fp(BASES[0]!);
  circle(ctx, home.x, home.y, 4 * FS, DIRT);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const sign of [-1, 1]) {
    const end = fp({ x: sign * 70.7, y: 70.7 });
    ctx.moveTo(home.x, home.y);
    ctx.lineTo(end.x, end.y);
  }
  ctx.stroke();

  for (const b of BASES.slice(1)) {
    const p = fp(b);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#fff';
    ctx.fillRect(-3, -3, 6, 6);
    ctx.restore();
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect(home.x - 3, home.y - 3, 6, 6);

  const left = fp({ x: -70.7, y: 70.7 });
  const right = fp({ x: 70.7, y: 70.7 });
  const center = fp({ x: 0, y: fenceDistance(0) });
  drawText(ctx, '100m', left.x - 6, left.y - 6, { size: 11, color: 'rgba(255,255,255,0.6)', align: 'right' });
  drawText(ctx, '100m', right.x + 6, right.y - 6, { size: 11, color: 'rgba(255,255,255,0.6)' });
  drawText(ctx, '122m', center.x, center.y - 8, { size: 11, color: 'rgba(255,255,255,0.6)', align: 'center' });
}

/** Position along the base path, measured in bases from home (0) to home again (4). */
function basePathPos(progress: number): Vec2 {
  const p = clamp(progress, 0, 4);
  const i = Math.min(3, Math.floor(p));
  return lerpVec(BASES[i]!, BASES[(i + 1) % 4]!, p - i);
}

/** How far (in bases) a runner who has to hold strays off the base before going back. */
const LEAD = 0.3;

function batterProgress(t: number): number {
  return t < RUN_TO_FIRST ? t / RUN_TO_FIRST : 1 + (t - RUN_TO_FIRST) / RUN_PER_BASE;
}

/** Where a runner is along the base path `t` seconds after contact; an out runner stops where tagged. */
function runnerProgress(r: RunnerMove, t: number, catchSec: number): number {
  const moving = r.out ? Math.min(t, r.outSec) : t;
  let p: number;
  if (r.action === 'hold') {
    const lead = Math.min(LEAD, Math.min(moving, catchSec) / RUN_PER_BASE);
    p = r.from + Math.max(0, lead - Math.max(0, moving - catchSec) / RUN_PER_BASE);
  } else if (r.from === 0) {
    p = batterProgress(moving);
  } else {
    const q = Math.max(0, moving - r.startSec) / Math.max(0.01, runnerArriveSec(r) - r.startSec);
    p = r.from + (r.to - r.from) * q;
  }
  return Math.min(p, r.out ? r.to - 0.08 : r.to);
}

function drawRunner(ctx: Ctx, pos: Vec2, color: string): void {
  const p = fp(pos);
  circle(ctx, p.x, p.y, 7.5, '#0d1222');
  circle(ctx, p.x, p.y, 6.5, '#fff');
  circle(ctx, p.x, p.y, 4.5, color);
}

/** An out runner floats up to heaven with wings and a halo, fading away as `q` goes 0 → 1. */
function drawAscendingRunner(ctx: Ctx, pos: Vec2, color: string, q: number): void {
  const p = fp(pos);
  const y = p.y - 96 * q * (2 - q);
  ctx.save();
  ctx.globalAlpha = 1 - q * q;
  const glow = ctx.createRadialGradient(p.x, y, 0, p.x, y, 26);
  glow.addColorStop(0, 'rgba(255, 250, 220, 0.85)');
  glow.addColorStop(1, 'rgba(255, 250, 220, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(p.x - 26, y - 26, 52, 52);
  const flap = Math.sin(q * Math.PI * 8) * 0.35;
  ctx.fillStyle = '#fff';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(p.x + side * 9, y - 2, 8, 3.5, side * (-0.5 + flap), 0, Math.PI * 2);
    ctx.fill();
  }
  circle(ctx, p.x, y, 6.5, '#fff');
  circle(ctx, p.x, y, 4.5, color);
  ctx.strokeStyle = '#ffe680';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(p.x, y - 11, 6, 2, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Fielders, runners and the ball `t` game-seconds after contact. */
function drawPlay(ctx: Ctx, play: FieldingPlay | FoulPlay, bases: Bases, defense: string, offense: string, t: number): void {
  const track = play.track;
  fielderPositions(play, bases, t).forEach((pos, i) => {
    const p = fp(pos);
    circle(ctx, p.x, p.y, 7.5, '#0d1222');
    circle(ctx, p.x, p.y, 6.5, defense);
    drawText(ctx, FIELDER_LABELS[i]!, p.x, p.y + 0.5, { size: 8, align: 'center', baseline: 'middle', weight: 700 });
  });

  // Runners (and the batter) on top of the fielders covering the bags.
  for (const r of play.runners) {
    const progress = runnerProgress(r, t, track.fieldSec);
    const pos = basePathPos(progress);
    if (r.out && t > r.outSec) {
      const q = (t - r.outSec) / ASCEND_SEC;
      if (q < 1) drawAscendingRunner(ctx, pos, offense, q);
    } else if (progress < 4) {
      drawRunner(ctx, pos, offense);
    }
  }

  drawBall(ctx, play, t);
}

/** The umpire's signal over the base, for a moment after each out/safe call. */
function drawCalls(ctx: Ctx, calls: BaseCall[], t: number): void {
  for (const c of calls) {
    if (t < c.sec || t > c.sec + 1.4) continue;
    const p = fp(BASES[c.base % 4]!);
    drawText(ctx, c.calledOut ? 'アウト!' : 'セーフ!', p.x, p.y - 16, {
      size: 15,
      align: 'center',
      weight: 800,
      outline: 4,
      color: c.calledOut ? '#ff7a6b' : '#62e391',
    });
  }
}

function banner(ctx: Ctx, text: string, y: number, color: string): void {
  ctx.fillStyle = 'rgba(5, 8, 20, 0.7)';
  ctx.fillRect(0, y - 22, VIEW_W, 32);
  drawText(ctx, text, VIEW_W / 2, y, { size: 18, align: 'center', weight: 800, color });
}

export function drawFieldView(ctx: Ctx, phase: InPlayPhase | ReviewPhase, now: number): void {
  const defense = TEAM_COLORS[fieldingSide(phase.before)];
  const offense = TEAM_COLORS[battingSide(phase.before)];
  if (phase.kind === 'review') return drawReplay(ctx, phase, now, defense, offense);

  const { play, before } = phase;
  const t = ((now - phase.startAt) / 1000) * PLAY_SPEED;
  drawPlay(ctx, play, before.bases, defense, offense, t);
  drawCalls(ctx, phase.calls, t);

  if (phase.request) {
    const who = phase.request.side === battingSide(before) ? '攻撃側' : '守備側';
    banner(ctx, `${who}の監督がリクエスト!`, 118, '#ffd640');
  }

  if (t >= resultShownSec(play)) {
    phase.messages.forEach((m, i) => {
      drawText(ctx, m, VIEW_W / 2, 190 + i * 34, {
        size: i === 0 ? 30 : 22,
        align: 'center',
        weight: 800,
        outline: 6,
        color: i === 0 ? '#fff' : '#ffd640',
      });
    });
  }
}

/** The review: the video of what really happened, slowed down around the call, then the ruling. */
function drawReplay(ctx: Ctx, phase: ReviewPhase, now: number, defense: string, offense: string): void {
  const { call } = phase.request;
  const from = Math.max(0, call.sec - REPLAY_LEAD_SEC);
  const to = call.sec + REPLAY_TAIL_SEC;
  const t = phase.verdict ? to : Math.min(to, from + ((now - phase.startAt) / 1000) * REPLAY_SPEED);
  drawPlay(ctx, phase.truth, phase.before.bases, defense, offense, t);

  const base = fp(BASES[call.base % 4]!);
  const pulse = 0.5 + 0.5 * Math.sin(now / 160);
  ctx.strokeStyle = `rgba(255, 214, 64, ${0.5 + pulse * 0.5})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(base.x, base.y, 22 + pulse * 4, 0, Math.PI * 2);
  ctx.stroke();

  // Letterbox and a REPLAY tag, like the stadium screen.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, VIEW_H - 26, VIEW_W, 26);
  if (Math.floor(now / 500) % 2 === 0) circle(ctx, 24, VIEW_H - 13, 5, '#ff4040');
  drawText(ctx, 'REPLAY  リプレー検証中', 36, VIEW_H - 8, { size: 13, weight: 800, color: '#fff' });

  if (!phase.verdict) {
    banner(ctx, '審判団が映像を確認しています…', 118, '#fff');
    return;
  }
  ctx.fillStyle = 'rgba(5, 8, 20, 0.72)';
  ctx.fillRect(0, 150, VIEW_W, 40 + phase.verdict.lines.length * 36);
  phase.verdict.lines.forEach((line, i) => {
    drawText(ctx, line, VIEW_W / 2, 182 + i * 36, {
      size: i === 0 ? 20 : 26,
      align: 'center',
      weight: 800,
      color: i === 0 ? 'rgba(255,255,255,0.8)' : phase.verdict!.overturned ? '#ffd640' : '#fff',
    });
  });
}

function drawBall(ctx: Ctx, play: Pick<FieldingPlay, 'track'>, t: number): void {
  const track = play.track;
  if (track.kind === 'air') {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    const end = Math.min(t, track.hangSec);
    for (let s = 0; s < end; s += 0.08) {
      const q = trackPositionAt(track, s);
      const p = fp(q);
      ctx.fillRect(p.x - 1, p.y - q.h * FS * 0.5 - 1, 2, 2);
    }
  }
  // Once the ball is on the ground (a grounder, or a fly that drops), its path is traced in red.
  const bounceFrom = track.kind === 'ground' ? 0 : track.hangSec;
  const bounceEnd = Math.min(t, track.fieldSec);
  const bounces = track.kind === 'ground' || track.fieldSec > track.hangSec;
  if (bounces && bounceEnd > bounceFrom) {
    ctx.fillStyle = 'rgba(255, 70, 70, 0.85)';
    for (let s = bounceFrom; s < bounceEnd; s += 0.15) {
      const p = fp(trackPositionAt(track, s));
      ctx.fillRect(p.x - 1.25, p.y - 1.25, 2.5, 2.5);
    }
  }
  const pos = trackPositionAt(track, t);
  const g = fp(pos);
  ctx.beginPath();
  ctx.ellipse(g.x, g.y, 4, 2, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fill();
  const r = Math.min(9, 3 + pos.h * 0.12);
  circle(ctx, g.x, g.y - pos.h * FS * 0.5, r, '#fafafa');
}
