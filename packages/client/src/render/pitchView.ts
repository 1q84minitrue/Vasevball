import {
  BALL_RADIUS,
  BAT_RADIUS,
  battingSide,
  BREAK_POWER,
  clamp,
  deg2rad,
  fieldingSide,
  lerp,
  PITCH_SPECS,
  pitchPositionAt,
  RELEASE_POINT,
} from '@vaseball/core';
import type { Pitch, PitchEvent, PitchType, SwingInput, Vec2 } from '@vaseball/core';
import type { InputState } from '../game/input';
import {
  ASCEND_MS,
  HIT_STOP_MS,
  isContact,
  STRIKEOUT_ASCEND_DELAY_MS,
  WINDUP_MS,
  type GameSession,
  type Phase,
} from '../game/session';
import { circle, drawText, TEAM_COLORS, VIEW_H, VIEW_W, type Ctx } from './common';

// Pseudo-3D catcher's-eye camera. x/y are zone units, z is meters toward the pitcher.
const ZW = 64; // pixels per zone unit at the plate
const CAM_D = 3;
const CAM_Y = 1.8;
const HORIZON_Y = 260;
const CX = VIEW_W / 2;
const GROUND_Y = -2.4;
const PITCHER_Z = 18.44;
const SWING_HALF_MS = 130;

const DIRT = '#b5835a';

export function project(x: number, y: number, z: number): { x: number; y: number; k: number } {
  const k = (ZW * CAM_D) / (CAM_D + z);
  return { x: CX + x * k, y: HORIZON_Y + (CAM_Y - y) * k, k };
}

export function screenToZone(sx: number, sy: number): Vec2 {
  return { x: (sx - CX) / ZW, y: CAM_Y - (sy - HORIZON_Y) / ZW };
}

const CROWD = ['#2b3656', '#3b4a70', '#6b4a5a', '#8a7a5a', '#4a6070', '#2f3a5a', '#5a3a4a'];

/** Static scenery, drawn once into an offscreen cache. */
export function drawStadium(ctx: Ctx): void {
  const sky = ctx.createLinearGradient(0, 0, 0, HORIZON_Y);
  sky.addColorStop(0, '#070d22');
  sky.addColorStop(1, '#1d3560');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, VIEW_W, HORIZON_Y + 10);

  for (const lx of [90, 710]) {
    const glow = ctx.createRadialGradient(lx, 54, 4, lx, 54, 90);
    glow.addColorStop(0, 'rgba(255, 250, 220, 0.45)');
    glow.addColorStop(1, 'rgba(255, 250, 220, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(lx - 90, 0, 180, 160);
    ctx.fillStyle = '#3a4560';
    ctx.fillRect(lx - 2, 60, 4, 140);
    ctx.fillStyle = '#fffbe6';
    ctx.fillRect(lx - 20, 46, 40, 14);
  }

  // Matches where the outfield wall (~120 m away, 3 m tall) projects.
  const standsTop = HORIZON_Y - 110;
  const wallTop = HORIZON_Y - 9;
  const grassTop = HORIZON_Y + 7;
  ctx.fillStyle = '#18213a';
  ctx.fillRect(0, standsTop, VIEW_W, wallTop - standsTop);
  for (let y = standsTop + 4; y < wallTop - 2; y += 6) {
    for (let x = (y / 6) % 2 === 0 ? 0 : 3; x < VIEW_W; x += 6) {
      const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      ctx.fillStyle = CROWD[Math.floor((h - Math.floor(h)) * CROWD.length)]!;
      ctx.fillRect(x, y, 3, 3);
    }
  }
  ctx.fillStyle = '#164a2c';
  ctx.fillRect(0, wallTop, VIEW_W, grassTop - wallTop);
  ctx.fillStyle = '#e8c547';
  ctx.fillRect(0, wallTop, VIEW_W, 2);

  const grass = ctx.createLinearGradient(0, grassTop, 0, VIEW_H);
  grass.addColorStop(0, '#2a6e35');
  grass.addColorStop(1, '#3c9a4a');
  ctx.fillStyle = grass;
  ctx.fillRect(0, grassTop, VIEW_W, VIEW_H - grassTop);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  for (let i = 0; i < 40; i += 2) {
    const yFar = Math.max(grassTop, project(0, GROUND_Y, i * 4 + 4).y);
    const yNear = project(0, GROUND_Y, i * 4).y;
    if (yNear > yFar) ctx.fillRect(0, yFar, VIEW_W, yNear - yFar);
  }

  // Infield skin behind the mound, the mound itself and the dirt around home plate.
  const skinFar = project(0, GROUND_Y, 44).y;
  const skinNear = project(0, GROUND_Y, 26).y;
  ctx.fillStyle = 'rgba(181, 131, 90, 0.85)';
  ctx.fillRect(0, skinFar, VIEW_W, skinNear - skinFar);
  const mound = project(0, GROUND_Y, PITCHER_Z);
  ctx.beginPath();
  ctx.ellipse(mound.x, mound.y, 70, 9, 0, 0, Math.PI * 2);
  ctx.fillStyle = DIRT;
  ctx.fill();
  const home = project(0, GROUND_Y, 0);
  ctx.beginPath();
  ctx.ellipse(home.x, home.y + 10, 330, 80, 0, 0, Math.PI * 2);
  ctx.fillStyle = DIRT;
  ctx.fill();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.lineWidth = 2;
  for (const sign of [-1, 1]) {
    const pts = [
      [1.7, 0.9],
      [7.4, 0.9],
      [7.4, -0.9],
      [1.7, -0.9],
    ].map(([x, z]) => project(sign * x!, GROUND_Y, z!));
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
  }
  const plate = [
    [-1, 0],
    [1, 0],
    [1, -0.22],
    [0, -0.43],
    [-1, -0.22],
  ].map(([x, z]) => project(x!, GROUND_Y, z!));
  ctx.beginPath();
  plate.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = '#f4f4f0';
  ctx.fill();
}

// Pitcher pose keyframes in units of body height, relative to the rubber: x to our right, y up.
// He is a right-hander facing us, so his throwing arm is on our left and his stride leg on our right.
interface PitcherPose {
  hip: Vec2;
  neck: Vec2;
  tElbow: Vec2;
  tHand: Vec2;
  gElbow: Vec2;
  gHand: Vec2;
  pKnee: Vec2;
  pFoot: Vec2;
  lKnee: Vec2;
  lFoot: Vec2;
}

const v = (x: number, y: number): Vec2 => ({ x, y });
/** Windup progress (1 = release) of each pose, and how the motion eases into it. */
const PITCHER_KEYS: { at: number; ease: (q: number) => number; pose: PitcherPose }[] = [
  // Set position: hands together at the chest.
  {
    at: 0,
    ease: (q) => q,
    pose: { hip: v(0, 0.5), neck: v(0, 0.8), tElbow: v(-0.1, 0.62), tHand: v(-0.02, 0.67), gElbow: v(0.1, 0.62), gHand: v(0.02, 0.67), pKnee: v(-0.07, 0.25), pFoot: v(-0.08, 0), lKnee: v(0.07, 0.25), lFoot: v(0.08, 0) },
  },
  // Leg lift: the front knee comes up to the hip, weight on the back leg.
  {
    at: 0.38,
    ease: (q) => smooth(q),
    pose: { hip: v(-0.02, 0.52), neck: v(-0.04, 0.82), tElbow: v(-0.1, 0.68), tHand: v(-0.01, 0.75), gElbow: v(0.08, 0.69), gHand: v(0.01, 0.75), pKnee: v(-0.05, 0.26), pFoot: v(-0.05, 0), lKnee: v(0.09, 0.54), lFoot: v(0.04, 0.3) },
  },
  // Stride: the hands break, the glove points at the plate and the ball is cocked high behind.
  {
    at: 0.74,
    ease: (q) => smooth(q),
    pose: { hip: v(0.02, 0.42), neck: v(0, 0.72), tElbow: v(-0.21, 0.73), tHand: v(-0.23, 0.92), gElbow: v(0.16, 0.74), gHand: v(0.23, 0.72), pKnee: v(-0.12, 0.2), pFoot: v(-0.1, 0), lKnee: v(0.14, 0.22), lFoot: v(0.16, -0.06) },
  },
  // Release, high three-quarters, the glove tucked in; the arm accelerates all the way.
  {
    at: 1,
    ease: (q) => q * q,
    pose: { hip: v(0.03, 0.4), neck: v(0.02, 0.68), tElbow: v(-0.16, 0.79), tHand: v(-0.13, 0.88), gElbow: v(0.13, 0.6), gHand: v(0.08, 0.55), pKnee: v(-0.1, 0.18), pFoot: v(-0.12, 0.02), lKnee: v(0.13, 0.2), lFoot: v(0.16, -0.06) },
  },
  // Follow-through: bent over, the arm whips across to the glove-side knee and the back foot comes up.
  {
    at: 1.3,
    ease: (q) => 1 - (1 - q) * (1 - q),
    pose: { hip: v(0.06, 0.36), neck: v(0.07, 0.58), tElbow: v(0.08, 0.42), tHand: v(0.18, 0.3), gElbow: v(0.17, 0.52), gHand: v(0.12, 0.44), pKnee: v(-0.05, 0.25), pFoot: v(-0.13, 0.17), lKnee: v(0.14, 0.2), lFoot: v(0.16, -0.06) },
  },
  // Fielding stance.
  {
    at: 1.9,
    ease: (q) => smooth(q),
    pose: { hip: v(0.02, 0.44), neck: v(0.02, 0.74), tElbow: v(-0.11, 0.55), tHand: v(-0.06, 0.46), gElbow: v(0.12, 0.55), gHand: v(0.07, 0.46), pKnee: v(-0.09, 0.22), pFoot: v(-0.1, 0), lKnee: v(0.1, 0.22), lFoot: v(0.12, -0.03) },
  },
];

function pitcherPose(windup: number): PitcherPose {
  const keys = PITCHER_KEYS;
  if (windup <= keys[0]!.at) return keys[0]!.pose;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (windup > b.at) continue;
    const q = b.ease((windup - a.at) / (b.at - a.at));
    const pose = {} as PitcherPose;
    for (const k of Object.keys(a.pose) as (keyof PitcherPose)[]) pose[k] = lerpV(a.pose[k], b.pose[k], q);
    return pose;
  }
  return keys[keys.length - 1]!.pose;
}

const lerpV = (a: Vec2, b: Vec2, q: number): Vec2 => ({ x: lerp(a.x, b.x, q), y: lerp(a.y, b.y, q) });

function drawPitcher(ctx: Ctx, windup: number, color: string, holdingBall: boolean): void {
  const base = project(0, GROUND_Y, PITCHER_Z);
  const H = (1.85 / 0.3) * base.k;
  const pose = pitcherPose(windup);
  const at = (p: Vec2) => ({ x: base.x + p.x * H, y: base.y - p.y * H });
  const limb = (width: number, style: string, ...pts: Vec2[]) => {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    pts.map(at).forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // The torso leans with the hips-to-neck line; shoulders sit across its top.
  const tilt = { x: pose.neck.x - pose.hip.x, y: pose.neck.y - pose.hip.y };
  const len = Math.hypot(tilt.x, tilt.y) || 1;
  const up = { x: tilt.x / len, y: tilt.y / len };
  const across = { x: up.y, y: -up.x };
  const shoulder = (side: number): Vec2 => ({ x: pose.neck.x + across.x * 0.07 * side, y: pose.neck.y + across.y * 0.07 * side });
  const legW = Math.max(2, H * 0.08);
  const armW = Math.max(2, H * 0.06);

  limb(legW, '#e8e8ee', pose.hip, pose.pKnee, pose.pFoot);
  limb(legW, '#e8e8ee', pose.hip, pose.lKnee, pose.lFoot);
  limb(H * 0.17, color, pose.hip, pose.neck);
  limb(armW, color, shoulder(1), pose.gElbow, pose.gHand);
  const glove = at(pose.gHand);
  circle(ctx, glove.x, glove.y, H * 0.05, '#5a3b22');

  const head = at({ x: pose.neck.x + up.x * 0.11, y: pose.neck.y + up.y * 0.11 });
  circle(ctx, head.x, head.y, H * 0.075, '#f0c8a0');
  ctx.fillStyle = color;
  ctx.fillRect(head.x - H * 0.08, head.y - H * 0.08, H * 0.16, H * 0.05);

  limb(armW, color, shoulder(-1), pose.tElbow, pose.tHand);
  const hand = at(pose.tHand);
  circle(ctx, hand.x, hand.y, Math.max(1.5, H * 0.03), holdingBall ? '#fff' : '#f0c8a0');
}

// The bat is modelled in 3D (all axes in zone units) and projected, so it sweeps around the batter.
interface Point3 {
  x: number;
  y: number;
  z: number;
}

const BAT_LEN = 3.3;
/** Sweet spot position as a fraction of the bat length from the hands. */
const SWEET_SPOT = 0.8;
/** One zone unit in meters (the plate is ~0.43 m wide). */
const ZONE_UNIT_M = 0.22;
const READY_HANDS: Point3 = { x: -2.3, y: 2.0, z: 0 };
const FINISH_HANDS: Point3 = { x: -2.5, y: 2.3, z: 2 };
// Bat yaw: 180 = pointing at the catcher, 90 = across the plate, 0 = at the pitcher, -90 = behind the batter.
const READY_YAW = 220;
const FINISH_YAW = -70;
const READY_TILT = 65;
const FINISH_TILT = 45;

interface BatterPose {
  base: { x: number; y: number };
  /** Where the batter's shadow falls (below `base` when floating). */
  ground: { x: number; y: number };
  H: number;
  hands: { x: number; y: number };
  knob: Point3;
  tip: Point3;
}

const smooth = (t: number): number => {
  const u = clamp(t, 0, 1);
  return u * u * (3 - 2 * u);
};

const lerp3 = (a: Point3, b: Point3, t: number): Point3 => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
});

function projectZone(p: Point3): { x: number; y: number; k: number } {
  return project(p.x, p.y, p.z * ZONE_UNIT_M);
}

function batDirection(yawDeg: number, tiltDeg: number): Point3 {
  const yaw = deg2rad(yawDeg);
  const tilt = deg2rad(tiltDeg);
  return { x: Math.cos(tilt) * Math.sin(yaw), y: Math.sin(tilt), z: Math.cos(tilt) * Math.cos(yaw) };
}

/**
 * Right-handed swing seen from the catcher. `swingS` runs from -1 (start) through 0 (contact) to 1 (finish).
 * The barrel lags behind the hands, flattens out behind the batter, sweeps through the zone so the sweet
 * spot meets `aim` at contact, then wraps around over the front shoulder.
 */
function batterPose(swingS: number | null, aim: Vec2 | null, shift: Vec2): BatterPose {
  const p = project(-3.2 + shift.x, GROUND_Y + shift.y, 0.3);
  const ground = project(-3.2 + shift.x, GROUND_Y, 0.3);
  const H = 6 * p.k;
  const readyHands = { x: READY_HANDS.x + shift.x, y: READY_HANDS.y + shift.y, z: READY_HANDS.z };
  const finishHands = { x: FINISH_HANDS.x + shift.x, y: FINISH_HANDS.y + shift.y, z: FINISH_HANDS.z };
  const s = swingS === null ? -1 : clamp(swingS, -1, 1);
  const target = aim ?? { x: 0, y: 0 };

  // Outside pitches are met deeper, inside ones out front; the barrel dips for low pitches.
  const contactYaw = 90 + 15 * target.x;
  const contactTilt = -17 + 13 * target.y;
  const contactDir = batDirection(contactYaw, contactTilt);
  const reach = BAT_LEN * SWEET_SPOT;
  const contactHands = {
    x: target.x - contactDir.x * reach,
    y: target.y - contactDir.y * reach,
    z: -contactDir.z * reach,
  };

  const u = Math.abs(s);
  const sweep = Math.sin((u * Math.PI) / 2); // fastest through the contact point
  const [endYaw, endTilt, endHands]: [number, number, Point3] = s <= 0 ? [READY_YAW, READY_TILT, readyHands] : [FINISH_YAW, FINISH_TILT, finishHands];
  const dir = batDirection(lerp(contactYaw, endYaw, sweep), lerp(contactTilt, endTilt, smooth((u - 0.3) / 0.7)));
  const knob = lerp3(contactHands, endHands, smooth(u));
  const tip = { x: knob.x + dir.x * BAT_LEN, y: knob.y + dir.y * BAT_LEN, z: knob.z + dir.z * BAT_LEN };
  const hands = projectZone(knob);
  return { base: p, ground, H, hands: { x: hands.x, y: hands.y }, knob, tip };
}

/** The batter's shift (zone units) toward the batting cursor, eased so it glides rather than jumps. */
let batterShift: Vec2 = { x: 0, y: 0 };
let batterShiftAt = 0;

function followCursor(target: Vec2, now: number): Vec2 {
  const dt = clamp((now - batterShiftAt) / 1000, 0, 0.1);
  batterShiftAt = now;
  const k = 1 - Math.exp(-dt / 0.05);
  // Higher aims lift the batter off the ground; low ones never sink below it.
  const goal = { x: target.x, y: Math.max(0, target.y) };
  batterShift = { x: lerp(batterShift.x, goal.x, k), y: lerp(batterShift.y, goal.y, k) };
  return batterShift;
}

function drawBatterBody(ctx: Ctx, pose: BatterPose, color: string): void {
  const { base, H, hands } = pose;
  const lift = pose.ground.y - base.y;
  if (lift > 1) {
    ctx.beginPath();
    ctx.ellipse(pose.ground.x, pose.ground.y, H * 0.16, H * 0.035, 0, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0, 0, 0, ${clamp(0.35 - lift / 600, 0.1, 0.35)})`;
    ctx.fill();
  }
  ctx.save();
  ctx.globalAlpha *= 0.93;
  ctx.lineCap = 'round';
  const hip = { x: base.x, y: base.y - H * 0.48 };
  const shoulder = { x: base.x + H * 0.02, y: base.y - H * 0.78 };

  ctx.strokeStyle = '#e9e9ef';
  ctx.lineWidth = H * 0.085;
  ctx.beginPath();
  ctx.moveTo(base.x - H * 0.14, base.y);
  ctx.lineTo(hip.x, hip.y);
  ctx.lineTo(base.x + H * 0.13, base.y);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = H * 0.2;
  ctx.beginPath();
  ctx.moveTo(hip.x, hip.y);
  ctx.lineTo(shoulder.x, shoulder.y);
  ctx.stroke();

  ctx.lineWidth = H * 0.055;
  ctx.beginPath();
  ctx.moveTo(shoulder.x + H * 0.05, shoulder.y + H * 0.02);
  ctx.lineTo(hands.x, hands.y);
  ctx.stroke();

  circle(ctx, base.x + H * 0.03, base.y - H * 0.9, H * 0.075, '#1c2340');
  ctx.fillStyle = color;
  ctx.fillRect(base.x + H * 0.03, base.y - H * 0.91, H * 0.1, H * 0.025);
  ctx.restore();
}

/**
 * Draws part of the batter rising to heaven after a strikeout, fading as `q` goes 0 → 1.
 * With `angel`, wings and a glow go behind and a halo above the head.
 */
function drawAscending(ctx: Ctx, pose: BatterPose, q: number, draw: () => void, angel = false): void {
  if (q <= 0) return draw();
  const { base, H } = pose;
  ctx.save();
  ctx.globalAlpha *= 1 - q * q;
  ctx.translate(0, -H * 0.8 * q * (2 - q));
  if (angel) {
    const cx = base.x;
    const cy = base.y - H * 0.65;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, H * 0.6);
    glow.addColorStop(0, 'rgba(255, 250, 220, 0.6)');
    glow.addColorStop(1, 'rgba(255, 250, 220, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(cx - H * 0.6, cy - H * 0.6, H * 1.2, H * 1.2);
    const flap = Math.sin(q * Math.PI * 8) * 0.3;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + side * H * 0.2, cy - H * 0.06, H * 0.2, H * 0.07, side * (-0.5 + flap), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  draw();
  if (angel) {
    ctx.strokeStyle = '#ffe680';
    ctx.lineWidth = Math.max(2, H * 0.014);
    ctx.beginPath();
    ctx.ellipse(base.x + H * 0.03, base.y - H * 1.02, H * 0.09, H * 0.025, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBat(ctx: Ctx, pose: BatterPose): void {
  const a = projectZone(pose.knob);
  const b = projectZone(pose.tip);
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = -(b.y - a.y) / len;
  const ny = (b.x - a.x) / len;
  const wa = 0.04 * a.k;
  const wb = 0.095 * b.k;
  ctx.beginPath();
  ctx.moveTo(a.x + nx * wa, a.y + ny * wa);
  ctx.lineTo(b.x + nx * wb, b.y + ny * wb);
  ctx.lineTo(b.x - nx * wb, b.y - ny * wb);
  ctx.lineTo(a.x - nx * wa, a.y - ny * wa);
  ctx.closePath();
  ctx.fillStyle = '#d8b07a';
  ctx.fill();
  ctx.strokeStyle = 'rgba(60, 35, 10, 0.6)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Rounded barrel end, which stays visible when the bat points toward the camera.
  circle(ctx, b.x, b.y, wb, '#d8b07a');
}

/**
 * Where the pitch would cross the plate if it moved like a fastball from `tMs` on: the current direction
 * of travel extended to the plate, plus the break a fastball would still have left. It starts at the
 * fastball read and converges on the real arrival point as the break shows up.
 */
function straightPrediction(pitch: Pitch, tMs: number): Vec2 {
  const p = clamp(tMs / pitch.flightMs, 0, 1);
  const pos = pitchPositionAt(pitch, p * pitch.flightMs);
  const rest = 1 - p;
  const n = BREAK_POWER;
  const slope = n * p ** (n - 1); // d(bend)/dp
  // Break still to come beyond the tangent line, as a fraction of the total break.
  const fbLeft = 1 - p ** n - slope * rest;
  const fb = PITCH_SPECS.fastball.brk;
  const vx = pitch.plate.x - pitch.brk.x - pitch.release.x + slope * pitch.brk.x;
  const vy = pitch.plate.y - pitch.brk.y - pitch.release.y + slope * pitch.brk.y;
  return { x: pos.x + vx * rest + fb.x * fbLeft, y: pos.y + vy * rest + fb.y * fbLeft };
}

/** Freezes the scene for a moment when the bat meets the ball. */
function withHitStop(now: number, releaseAt: number, pitch: Pitch, swing: SwingInput | null, event: PitchEvent | null): number {
  if (!isContact(event)) return now;
  const hitAt = releaseAt + Math.max(pitch.flightMs, swing?.swing ? swing.timeMs : 0);
  return now < hitAt ? now : Math.max(hitAt, now - HIT_STOP_MS);
}

function drawPredictionPointer(ctx: Ctx, at: Vec2): void {
  const p = project(at.x, at.y, 0);
  const r = BALL_RADIUS * ZW;
  ctx.strokeStyle = 'rgba(255, 110, 90, 0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    ctx.moveTo(p.x + dx * r * 0.4, p.y + dy * r * 0.4);
    ctx.lineTo(p.x + dx * r * 1.6, p.y + dy * r * 1.6);
  }
  ctx.stroke();
}

function drawZone(ctx: Ctx): void {
  const tl = project(-1, 1, 0);
  const br = project(1, -1, 0);
  const w = br.x - tl.x;
  const h = br.y - tl.y;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.fillRect(tl.x, tl.y, w, h);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const f of [1 / 3, 2 / 3]) {
    ctx.moveTo(tl.x + w * f, tl.y);
    ctx.lineTo(tl.x + w * f, br.y);
    ctx.moveTo(tl.x, tl.y + h * f);
    ctx.lineTo(br.x, tl.y + h * f);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 2;
  ctx.strokeRect(tl.x, tl.y, w, h);
}

function drawBallAt(ctx: Ctx, x: number, y: number, z: number): void {
  const p = project(x, y, z);
  const r = Math.max(1.6, BALL_RADIUS * p.k * 0.9);
  const g = project(x, GROUND_Y, z);
  ctx.beginPath();
  ctx.ellipse(g.x, g.y, r * 1.2, r * 0.35, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fill();
  circle(ctx, p.x, p.y, r, '#fafafa');
  if (r > 4) {
    ctx.strokeStyle = '#d33';
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.beginPath();
    ctx.arc(p.x - r * 0.9, p.y, r * 0.7, -0.9, 0.9);
    ctx.stroke();
  }
}

function drawBatCursor(ctx: Ctx, aim: Vec2): void {
  const p = project(aim.x, aim.y, 0);
  const r = BAT_RADIUS * ZW;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 214, 64, 0.12)';
  ctx.fill();
  ctx.strokeStyle = '#ffd640';
  ctx.lineWidth = 2;
  ctx.stroke();
  circle(ctx, p.x, p.y, 3, '#ffd640');
}

function drawPitchTarget(ctx: Ctx, aim: Vec2, type: PitchType): void {
  const spec = PITCH_SPECS[type];
  // Expected path (without control error) so the player can see how the pitch moves.
  const preview = { release: RELEASE_POINT, plate: aim, brk: spec.brk, flightMs: 1 };
  ctx.fillStyle = 'rgba(140, 220, 255, 0.7)';
  for (let i = 0; i <= 20; i++) {
    const pos = pitchPositionAt(preview, i / 20);
    const p = project(pos.x, pos.y, pos.z);
    ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
  }
  const p = project(aim.x, aim.y, 0);
  ctx.strokeStyle = '#8cdcff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
  ctx.moveTo(p.x - 16, p.y);
  ctx.lineTo(p.x + 16, p.y);
  ctx.moveTo(p.x, p.y - 16);
  ctx.lineTo(p.x, p.y + 16);
  ctx.stroke();
  drawText(ctx, spec.label, p.x + 18, p.y - 12, { size: 13, color: '#8cdcff', outline: 3 });
}

function swingProgress(swing: SwingInput | null, releaseAt: number, now: number): number | null {
  if (!swing || !swing.swing) return null;
  return (now - (releaseAt + swing.timeMs)) / SWING_HALF_MS;
}

function drawFlyingBall(ctx: Ctx, phase: Extract<Phase, { kind: 'pitch' }>, t: number): void {
  const event = phase.event;
  if (!event) return;
  const start = pitchPositionAt(phase.pitch, phase.pitch.flightMs);
  const p0 = project(start.x, start.y, 0);
  const dt = (t - phase.pitch.flightMs) / 1000;
  const hitBatter = event.kind === 'hitByPitch';
  if (dt < 0.12 && !hitBatter) {
    const burst = ctx.createRadialGradient(p0.x, p0.y, 0, p0.x, p0.y, 40);
    burst.addColorStop(0, 'rgba(255, 250, 210, 0.9)');
    burst.addColorStop(1, 'rgba(255, 250, 210, 0)');
    ctx.fillStyle = burst;
    ctx.fillRect(p0.x - 40, p0.y - 40, 80, 80);
  }
  let vx: number;
  let vy: number;
  if (event.kind === 'inPlay') {
    const b = event.play.batted;
    vx = Math.sin((b.sprayDeg * Math.PI) / 180) * 700;
    vy = -(150 + b.launchDeg * 9);
  } else if (hitBatter) {
    // Glances off the batter and drops.
    vx = 220;
    vy = -260;
  } else {
    vx = (phase.pitch.plate.x >= 0 ? 1 : -1) * 600;
    vy = -700;
  }
  const r = (BALL_RADIUS * ZW * 0.9) / (1 + dt * 5);
  circle(ctx, p0.x + vx * dt, p0.y + vy * dt + 300 * dt * dt, Math.max(1.5, r), '#fafafa');
}

export function drawPitchView(ctx: Ctx, session: GameSession | null, input: InputState, now: number): void {
  const phase: Phase = session?.phase ?? { kind: 'idle' };
  const state = session?.state;
  const pitcherColor = state ? TEAM_COLORS[fieldingSide(state)] : TEAM_COLORS.home;
  const batterColor = state ? TEAM_COLORS[battingSide(state)] : TEAM_COLORS.away;
  if (phase.kind === 'pitch' || phase.kind === 'result') now = withHitStop(now, phase.releaseAt, phase.pitch, phase.swing, phase.event);

  let windup = 0;
  let swingS: number | null = null;
  let swingAim: Vec2 | null = null;
  if (phase.kind === 'pitch') {
    windup = (now - (phase.releaseAt - WINDUP_MS)) / WINDUP_MS;
    swingS = swingProgress(phase.swing, phase.releaseAt, now);
    if (phase.swing?.swing) swingAim = phase.swing.aim;
  } else if (phase.kind === 'result') {
    windup = 2;
    swingS = swingProgress(phase.swing, phase.releaseAt, now);
    if (phase.swing.swing) swingAim = phase.swing.aim;
  }

  drawPitcher(ctx, windup, pitcherColor, phase.kind === 'pitch' && windup < 1);
  // The batter follows the batting cursor (or, for the CPU, where it swings).
  const humanAim = (phase.kind === 'aiming' || phase.kind === 'pitch') && phase.humanBatting ? input.aim : null;
  const shiftTarget = swingAim ?? humanAim ?? (phase.kind === 'result' ? batterShift : { x: 0, y: 0 });
  const pose = batterPose(swingS, swingAim, followCursor(shiftTarget, now));
  const ascent =
    phase.kind === 'result' && phase.strikeout ? clamp((now - phase.startAt - STRIKEOUT_ASCEND_DELAY_MS) / ASCEND_MS, 0, 1) : 0;
  if (ascent < 1) drawAscending(ctx, pose, ascent, () => drawBatterBody(ctx, pose, batterColor), true);
  drawZone(ctx);

  if (phase.kind === 'aiming' && phase.humanPitching) drawPitchTarget(ctx, input.aim, input.pitchType);

  if (phase.kind === 'pitch') {
    if (phase.humanPitching) {
      const p = project(phase.target.x, phase.target.y, 0);
      ctx.strokeStyle = 'rgba(140, 220, 255, 0.6)';
      ctx.lineWidth = 2;
      ctx.strokeRect(p.x - 6, p.y - 6, 12, 12);
    }
    const t = now - phase.releaseAt;
    const deflected = isContact(phase.event) || phase.event?.kind === 'hitByPitch';
    if (phase.humanBatting && t >= 0 && t <= phase.pitch.flightMs) drawPredictionPointer(ctx, straightPrediction(phase.pitch, t));
    if (t >= 0) {
      if (deflected && t > phase.pitch.flightMs) drawFlyingBall(ctx, phase, t);
      else if (t <= phase.pitch.flightMs * 1.05) {
        const pos = pitchPositionAt(phase.pitch, t);
        drawBallAt(ctx, pos.x, pos.y, pos.z);
      }
    }
  }

  if (phase.kind === 'result') {
    const p = project(phase.pitch.plate.x, phase.pitch.plate.y, 0);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, BALL_RADIUS * ZW, 0, Math.PI * 2);
    ctx.stroke();
    if (phase.swing.swing) {
      const a = project(phase.swing.aim.x, phase.swing.aim.y, 0);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(255, 214, 64, 0.8)';
      ctx.beginPath();
      ctx.arc(a.x, a.y, BAT_RADIUS * ZW, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  if (ascent < 1) drawAscending(ctx, pose, ascent, () => drawBat(ctx, pose));

  const humanBatting = (phase.kind === 'aiming' || phase.kind === 'pitch') && phase.humanBatting;
  if (humanBatting) drawBatCursor(ctx, input.aim);
}
