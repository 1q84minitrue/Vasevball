import type { Side } from '@vaseball/core';

/** Logical canvas size; everything is drawn in these units and scaled to the real canvas. */
export const VIEW_W = 800;
export const VIEW_H = 600;

export const FONT = '"Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", "Meiryo", system-ui, sans-serif';

export const TEAM_COLORS: Record<Side, string> = { away: '#e0523f', home: '#3f7be0' };

export type Ctx = CanvasRenderingContext2D;

export interface TextOptions {
  size?: number;
  color?: string;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  weight?: number;
  outline?: number;
}

export function drawText(ctx: Ctx, text: string, x: number, y: number, opts: TextOptions = {}): void {
  const { size = 14, color = '#fff', align = 'left', baseline = 'alphabetic', weight = 600, outline = 0 } = opts;
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (outline > 0) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = outline;
    ctx.strokeStyle = 'rgba(5, 8, 20, 0.85)';
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export function panel(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 8);
  ctx.fillStyle = 'rgba(8, 12, 26, 0.82)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

export function circle(ctx: Ctx, x: number, y: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}
