import type { Vec2 } from './types';

export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export const deg2rad = (deg: number): number => (deg * Math.PI) / 180;

export const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
