import './style.css';
import { battingSide, currentBatter, fieldingSide, inningLabel, PITCH_SPECS, PITCH_TYPES } from '@vaseball/core';
import type { BotLevel, GameState, Side } from '@vaseball/core';
import { HumanBatter, HumanPitcher } from './game/controllers';
import { InputState } from './game/input';
import { GameSession } from './game/session';
import { Renderer } from './render/renderer';

function $<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

const canvas = $<HTMLCanvasElement>('#game');
const menu = $<HTMLElement>('#menu');
const finalOverlay = $<HTMLElement>('#final');
const pitchPanel = $<HTMLElement>('#pitch-panel');
const log = $<HTMLOListElement>('#log');
const quitButton = $<HTMLButtonElement>('#quit');

const renderer = new Renderer(canvas);
const input = new InputState(canvas, (x, y) => renderer.screenToZone(x, y));

let session: GameSession | null = null;
let humanPitcher: HumanPitcher | null = null;
let humanBatter: HumanBatter | null = null;

const pitchButtons = PITCH_TYPES.map((type, i) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `${i + 1} ${PITCH_SPECS[type].label}`;
  button.addEventListener('click', () => {
    input.pitchType = type;
    button.blur();
  });
  pitchPanel.append(button);
  return { type, button };
});

input.onAction = (now) => {
  const phase = session?.phase;
  if (phase?.kind === 'aiming' && phase.humanPitching) humanPitcher?.throwPitch();
  else if (phase?.kind === 'pitch' && phase.humanBatting) humanBatter?.swing(now);
};

const PITCH_NOISE = new Set(['ボール', 'ストライク', '空振り', 'ファウル']);

function addLog(messages: string[], before: GameState): void {
  const side = battingSide(before);
  const batter = currentBatter(before);
  const item = document.createElement('li');
  item.className = side;
  const summary = messages.filter((m) => !PITCH_NOISE.has(m)).join(' ');
  item.textContent = `${inningLabel(before)}  ${before.teams[side].name} ${batter.order}番 ${batter.name}: ${summary}`;
  log.prepend(item);
  while (log.children.length > 12) log.lastElementChild?.remove();
}

function showFinal(state: GameState, humanSide: Side): void {
  const title = state.winner === 'tie' ? '引き分け' : state.winner === humanSide ? '勝利!' : '敗北…';
  $<HTMLElement>('#final-title').textContent = title;
  $<HTMLElement>('#final-score').textContent =
    `${state.teams.away.name} ${state.runs.away} - ${state.runs.home} ${state.teams.home.name}`;
  finalOverlay.hidden = false;
}

function startGame(): void {
  const side = (document.querySelector<HTMLInputElement>('input[name="side"]:checked')?.value ?? 'away') as Side;
  const innings = Number($<HTMLSelectElement>('#innings').value);
  const level = $<HTMLSelectElement>('#level').value as BotLevel;

  session?.stop();
  // Fresh controllers per game so pending inputs from an abandoned game cannot leak into this one.
  humanPitcher = new HumanPitcher(input);
  humanBatter = new HumanBatter(input);
  const s = new GameSession({ humanSide: side, innings, level }, { pitcher: humanPitcher, batter: humanBatter });
  s.onLog = addLog;
  s.onFinal = (state) => showFinal(state, side);
  session = s;

  log.replaceChildren();
  menu.hidden = true;
  finalOverlay.hidden = true;
  quitButton.hidden = false;
  input.aim = { x: 0, y: 0 };
  (document.activeElement as HTMLElement | null)?.blur();
  void s.run();
}

function backToMenu(): void {
  session?.stop();
  session = null;
  finalOverlay.hidden = true;
  quitButton.hidden = true;
  pitchPanel.hidden = true;
  menu.hidden = false;
}

$<HTMLButtonElement>('#start').addEventListener('click', startGame);
$<HTMLButtonElement>('#again').addEventListener('click', backToMenu);
quitButton.addEventListener('click', backToMenu);

function syncControls(): void {
  const phase = session?.phase;
  input.enabled = !!session && phase?.kind !== 'final';
  const humanFielding = !!session && session.state.status === 'playing' && fieldingSide(session.state) === session.humanSide;
  pitchPanel.hidden = !humanFielding;
  for (const { type, button } of pitchButtons) button.setAttribute('aria-pressed', String(type === input.pitchType));
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  input.update(dt);
  syncControls();
  renderer.draw(session, input, now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
