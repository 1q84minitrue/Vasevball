import type { Vec2 } from '@vaseball/core';
import type { InputState } from '../game/input';
import type { GameSession } from '../game/session';
import { VIEW_H, VIEW_W, type Ctx } from './common';
import { drawFieldBackground, drawFieldView } from './fieldView';
import { drawHud } from './hud';
import { drawPitchView, drawStadium, screenToZone } from './pitchView';

export class Renderer {
  private readonly ctx: Ctx;
  private sx = 1;
  private sy = 1;
  private stadiumCache: HTMLCanvasElement | null = null;
  private fieldCache: HTMLCanvasElement | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not supported');
    this.ctx = ctx;
  }

  /** Converts a pointer position to strike-zone coordinates. */
  screenToZone(clientX: number, clientY: number): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    return screenToZone(((clientX - rect.left) / rect.width) * VIEW_W, ((clientY - rect.top) / rect.height) * VIEW_H);
  }

  draw(session: GameSession | null, input: InputState, now: number): void {
    this.fitToDisplay();
    const ctx = this.ctx;
    const phase = session?.phase;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (phase?.kind === 'inPlay' || phase?.kind === 'review') {
      this.fieldCache ??= this.prerender(drawFieldBackground);
      ctx.drawImage(this.fieldCache, 0, 0);
      ctx.setTransform(this.sx, 0, 0, this.sy, 0, 0);
      drawFieldView(ctx, phase, now);
    } else {
      this.stadiumCache ??= this.prerender(drawStadium);
      ctx.drawImage(this.stadiumCache, 0, 0);
      ctx.setTransform(this.sx, 0, 0, this.sy, 0, 0);
      drawPitchView(ctx, session, input, now);
    }
    if (session) drawHud(ctx, session, input, now);
  }

  private fitToDisplay(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (w === this.canvas.width && h === this.canvas.height) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.sx = w / VIEW_W;
    this.sy = h / VIEW_H;
    this.stadiumCache = null;
    this.fieldCache = null;
  }

  private prerender(paint: (ctx: Ctx) => void): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.setTransform(this.sx, 0, 0, this.sy, 0, 0);
      paint(ctx);
    }
    return c;
  }
}
