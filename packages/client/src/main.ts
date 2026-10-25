import './style.css';
import {
  BAT_SPECS,
  BAT_TYPES,
  battingSide,
  currentBatter,
  fieldingSide,
  inningLabel,
  PITCH_SPECS,
  PITCH_TYPES,
  requestableCall,
  TARGET_BOUNDS,
} from '@vaseball/core';
import type { BatType, BotLevel, GameState, Side } from '@vaseball/core';
import { Sound } from './audio';
import { HumanBatter, HumanPitcher } from './game/controllers';
import { BATTING_BOUNDS, InputState } from './game/input';
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
const timeOverlay = $<HTMLElement>('#time');
const batList = $<HTMLElement>('#bat-list');
const pitchPanel = $<HTMLElement>('#pitch-panel');
const controls = $<HTMLElement>('#controls');
const buntButton = $<HTMLButtonElement>('#bunt-btn');
const timeButton = $<HTMLButtonElement>('#time-btn');
const requestButton = $<HTMLButtonElement>('#request-btn');
const muteButton = $<HTMLButtonElement>('#mute-btn');
const toast = $<HTMLElement>('#toast');
const log = $<HTMLOListElement>('#log');
const quitButton = $<HTMLButtonElement>('#quit');

const renderer = new Renderer(canvas);
const input = new InputState(canvas, (x, y) => renderer.screenToZone(x, y));
const sound = new Sound();

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

input.onCommand = (command) => {
  if (command === 'mute') toggleMute();
  else if (command === 'time') toggleTime();
  else requestReview();
};

let toastTimer = 0;
function showToast(text: string): void {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 2200);
}

function toggleMute(): void {
  sound.unlock();
  sound.toggleMute();
}

function requestReview(): void {
  if (!session) return;
  const why = session.requestReview(session.humanSide);
  if (why) showToast(why);
}

// --- タイム and the bat rack ---------------------------------------------------------------

const STAT_MAX = { radius: 0.85, power: 1.13, timing: 120, delay: 250 };

function renderBatList(selected: BatType): void {
  batList.replaceChildren(
    ...BAT_TYPES.map((type) => {
      const spec = BAT_SPECS[type];
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'bat-option';
      option.setAttribute('role', 'radio');
      option.setAttribute('aria-checked', String(type === selected));
      const name = document.createElement('strong');
      name.textContent = spec.label;
      const desc = document.createElement('span');
      desc.textContent = spec.description;
      const stats = document.createElement('div');
      stats.className = 'bat-stats';
      for (const [label, value] of [
        ['ミート', spec.radius / STAT_MAX.radius],
        ['パワー', spec.power / STAT_MAX.power],
        ['タイミングの幅', spec.timingWindowMs / STAT_MAX.timing],
        ['振り出しの速さ', 1 - spec.swingDelayMs / STAT_MAX.delay],
      ] as const) {
        const l = document.createElement('span');
        l.textContent = label;
        const m = document.createElement('meter');
        m.min = 0;
        m.max = 1;
        m.value = value;
        stats.append(l, m);
      }
      option.append(name, desc, stats);
      option.addEventListener('click', () => {
        if (!session) return;
        session.setBat(session.humanSide, type);
        renderBatList(type);
      });
      return option;
    }),
  );
}

function toggleTime(): void {
  if (!session) return;
  if (session.paused) return resumeFromTime();
  if (!session.callTime()) {
    showToast('タイムは投球の合間にだけかけられます');
    return;
  }
  const batting = battingSide(session.state) === session.humanSide;
  $<HTMLElement>('#time-note').textContent = batting ? 'バットを選んでください' : 'バットを選んでください (次の攻撃から使います)';
  renderBatList(session.state.bats[session.humanSide]);
  timeOverlay.hidden = false;
  input.buntHeld = false;
}

function resumeFromTime(): void {
  timeOverlay.hidden = true;
  session?.resume();
  (document.activeElement as HTMLElement | null)?.blur();
}

// --- Game flow ---------------------------------------------------------------------------

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

  // Browsers only allow audio to start from a click like this one.
  sound.unlock();
  sound.startBgm();

  session?.stop();
  // Fresh controllers per game so pending inputs from an abandoned game cannot leak into this one.
  humanPitcher = new HumanPitcher(input);
  humanBatter = new HumanBatter(input);
  const s = new GameSession({ humanSide: side, innings, level }, { pitcher: humanPitcher, batter: humanBatter });
  s.onLog = addLog;
  s.onFinal = (state) => showFinal(state, side);
  s.onCue = (cue) => sound.play(cue);
  session = s;

  log.replaceChildren();
  menu.hidden = true;
  finalOverlay.hidden = true;
  timeOverlay.hidden = true;
  quitButton.hidden = false;
  input.aim = { x: 0, y: 0 };
  (document.activeElement as HTMLElement | null)?.blur();
  void s.run();
}

function backToMenu(): void {
  session?.stop();
  session = null;
  finalOverlay.hidden = true;
  timeOverlay.hidden = true;
  quitButton.hidden = true;
  pitchPanel.hidden = true;
  menu.hidden = false;
}

$<HTMLButtonElement>('#start').addEventListener('click', startGame);
$<HTMLButtonElement>('#again').addEventListener('click', backToMenu);
$<HTMLButtonElement>('#resume').addEventListener('click', resumeFromTime);
quitButton.addEventListener('click', backToMenu);

// The bunt button works like holding B.
buntButton.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  input.buntHeld = true;
});
for (const type of ['pointerup', 'pointerleave', 'pointercancel'] as const) buntButton.addEventListener(type, () => (input.buntHeld = false));
timeButton.addEventListener('click', () => {
  toggleTime();
  timeButton.blur();
});
requestButton.addEventListener('click', () => {
  requestReview();
  requestButton.blur();
});
muteButton.addEventListener('click', () => {
  toggleMute();
  muteButton.blur();
});

function canRequest(s: GameSession): boolean {
  const phase = s.phase;
  if (phase.kind !== 'inPlay' || phase.request || phase.before.requestsLeft[s.humanSide] <= 0) return false;
  return requestableCall(phase.calls, s.humanSide === battingSide(phase.before)) !== null;
}

function syncControls(): void {
  const phase = session?.phase;
  input.enabled = !!session && !session.paused && phase?.kind !== 'final';
  const humanFielding = !!session && session.state.status === 'playing' && fieldingSide(session.state) === session.humanSide;
  pitchPanel.hidden = !humanFielding;
  for (const { type, button } of pitchButtons) button.setAttribute('aria-pressed', String(type === input.pitchType));
  // Pitchers may aim at the batter's body and head; the batting cursor stays around the zone.
  input.setBounds(phase?.kind === 'aiming' && phase.humanPitching ? TARGET_BOUNDS : BATTING_BOUNDS);

  controls.hidden = !session || phase?.kind === 'final';
  if (session) {
    const humanBatting = (phase?.kind === 'aiming' || phase?.kind === 'pitch') && phase.humanBatting;
    buntButton.disabled = !humanBatting;
    buntButton.setAttribute('aria-pressed', String(input.buntHeld && humanBatting));
    timeButton.disabled = !session.canCallTime() && !session.paused;
    requestButton.disabled = !canRequest(session);
    const state = phase?.kind === 'inPlay' || phase?.kind === 'review' ? phase.before : session.state;
    setLabel(requestButton, `リクエスト (残${state.requestsLeft[session.humanSide]}) `, 'R');
  }
  setLabel(muteButton, sound.muted ? '音 OFF ' : '音 ON ', 'M');
}

function setLabel(button: HTMLButtonElement, text: string, key: string): void {
  if (button.dataset.label === text) return;
  button.dataset.label = text;
  button.textContent = text;
  button.append(Object.assign(document.createElement('kbd'), { textContent: key }));
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
