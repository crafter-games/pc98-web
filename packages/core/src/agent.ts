import { keyCode } from './keyboard.js';
import type { PC98 } from './pc98.js';

export const FRAME_HZ = 56.42;

export function secondsToFrames(s: number): number {
  return Math.max(1, Math.round(s * FRAME_HZ));
}

/**
 * How emulated time passes. Headless sessions run frames on demand; a page
 * playing in real time just waits until its render loop has run them.
 */
export interface Clock {
  /** Lets `frames` frames pass. Resolves false if the machine powered off. */
  advance(frames: number): Promise<boolean>;
}

/** Runs frames directly: deterministic and faster than real time. */
export function steppedClock(pc: () => PC98): Clock {
  return {
    async advance(frames) {
      const m = pc();
      for (let i = 0; i < frames; i++) if (!m.runFrame(i === frames - 1)) return false;
      return true;
    },
  };
}

export interface RunOptions {
  /** Time to run without conditions, or the timeout with one. */
  seconds?: number;
  /** Regular expression tested against the text screen. */
  untilText?: string;
  /** Stop once the picture has not changed for this long. */
  untilStableSeconds?: number;
  /** Stop as soon as the picture differs from when the run started (more than a blinking icon). */
  untilChanged?: boolean;
}

/**
 * A screen counts as stable while it only alternates between at most two
 * exact pictures: a blinking cursor or "waiting for input" icon flips between
 * them. Text being typed out or a counter going up produces a new
 * picture every time, and any disk access means the guest is still loading;
 * both restart the quiet period.
 */
const STABLE_MAX_PICTURES = 2;

/** Pixels a press must change to count as having done something (more than a blinking icon). */
export const DEFAULT_STABLE_TOLERANCE = 600;

function hashRgba(rgba: Uint8ClampedArray): number {
  const w = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >> 2);
  let h = 0x811c9dc5;
  for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w[i], 0x01000193);
  return h >>> 0;
}

export interface AdvanceOptions {
  /** Key to press. Default RETURN. */
  key?: string;
  /** How many times. Default 1. */
  presses?: number;
  /** After each press, wait until the screen settles, at most this long. Default 5. */
  maxWaitSeconds?: number;
  /** The screen must stay settled this long. Default 0.4. */
  settleSeconds?: number;
}

export interface AdvanceStep {
  /** Seconds from the press until the screen settled (or maxWaitSeconds). */
  seconds: number;
  settled: boolean;
  /** The screen after this press settled. */
  screen: { width: number; height: number; rgba: Uint8ClampedArray };
  text: string;
  /** The press changed nothing on screen (e.g. a menu waiting for arrow keys); advancing stopped. */
  unchanged: boolean;
}

export interface RunResult {
  outcome: 'ran' | 'text-matched' | 'stable' | 'changed' | 'timeout' | 'powered-off';
  /** Emulated seconds that passed. */
  seconds: number;
}

export interface KeyOptions {
  shift?: boolean;
  ctrl?: boolean;
  grph?: boolean;
  times?: number;
  /** Pause between repeated presses, so games that animate text see each one. Default 0.3. */
  intervalSeconds?: number;
}

export interface MouseOptions {
  dx?: number;
  dy?: number;
  button?: 'left' | 'right';
  action?: 'move' | 'click' | 'down' | 'up';
}

/**
 * What an agent does with a machine, independent of where it runs. The MCP
 * server uses it headless; the web page uses it to serve an attached agent.
 */
export class AgentOps {
  constructor(private readonly pc: () => PC98, private readonly clock: Clock) {}

  get machine(): PC98 { return this.pc(); }

  readText(): string {
    return this.pc().textScreen().replace(/\n+$/, '');
  }

  /** Waits until queued input has reached the guest, then lets `seconds` pass. */
  async settle(seconds: number): Promise<void> {
    let guard = secondsToFrames(30);
    while (this.pc().pendingInput > 0 && guard-- > 0) {
      if (!(await this.clock.advance(1))) return;
    }
    if (seconds > 0) await this.clock.advance(secondsToFrames(seconds));
  }

  pressKey(key: string, opts: KeyOptions = {}): void {
    const code = keyCode(key);
    if (code === undefined) throw new Error(`Unknown key "${key}"`);
    const times = opts.times ?? 1;
    for (let i = 0; i < times; i++) {
      this.pc().pressKey(code, opts);
      if (i < times - 1) this.pc().queueGap(secondsToFrames(opts.intervalSeconds ?? 0.3));
    }
  }

  typeText(text: string): void {
    this.pc().typeText(text);
  }

  mouse(opts: MouseOptions): void {
    const pc = this.pc();
    const action = opts.action ?? (opts.button ? 'click' : 'move');
    // Spread the motion over a few frames: games poll the mouse once per frame.
    const steps = 4;
    const dx = opts.dx ?? 0;
    const dy = opts.dy ?? 0;
    for (let i = 0; i < steps; i++) {
      const sx = Math.trunc((dx * (i + 1)) / steps) - Math.trunc((dx * i) / steps);
      const sy = Math.trunc((dy * (i + 1)) / steps) - Math.trunc((dy * i) / steps);
      pc.schedule(i, () => pc.mouseMove(sx, sy));
    }
    const left = opts.button === 'left';
    const right = opts.button === 'right';
    if (action === 'click') {
      pc.schedule(steps + 1, () => pc.mouseButtons(left, right));
      pc.schedule(steps + 5, () => pc.mouseButtons(false, false));
    } else if (action === 'down') {
      pc.schedule(steps + 1, () => pc.mouseButtons(left, right));
    } else if (action === 'up') {
      pc.schedule(steps + 1, () => pc.mouseButtons(false, false));
    }
    pc.schedule(steps + 7, () => {});
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const pc = this.pc();
    const conditional = opts.untilText !== undefined || opts.untilStableSeconds !== undefined || !!opts.untilChanged;
    const maxFrames = secondsToFrames(opts.seconds ?? (conditional ? 60 : 1));
    const re = opts.untilText !== undefined ? new RegExp(opts.untilText, 'm') : undefined;
    const stableFrames = opts.untilStableSeconds !== undefined ? secondsToFrames(opts.untilStableSeconds) : 0;
    const start = pc.elapsedMs;
    const done = (outcome: RunResult['outcome']): RunResult => ({ outcome, seconds: (this.pc().elapsedMs - start) / 1000 });

    if (!conditional) {
      return done((await this.clock.advance(maxFrames)) ? 'ran' : 'powered-off');
    }
    // Check every few frames: cheap enough headless, and in real time the
    // page only renders once per animation frame anyway.
    const step = 4;
    const start0 = pc.screen().rgba;
    let seen = new Set<number>([hashRgba(start0)]);
    let sameFor = 0;
    let disk = pc.diskActivity;
    for (let ran = 0; ran < maxFrames; ran += step) {
      if (!(await this.clock.advance(Math.min(step, maxFrames - ran)))) return done('powered-off');
      if (re && re.test(this.pc().textScreen())) return done('text-matched');
      if (opts.untilChanged && changedPixels(start0, this.pc().screen().rgba) > DEFAULT_STABLE_TOLERANCE) return done('changed');
      if (stableFrames) {
        const h = hashRgba(this.pc().screen().rgba);
        const nowDisk = this.pc().diskActivity;
        const loading = nowDisk !== disk;
        disk = nowDisk;
        if (loading) {
          seen = new Set([h]);
          sameFor = 0;
        } else if (seen.has(h) || seen.size < STABLE_MAX_PICTURES) {
          seen.add(h);
          sameFor += step;
        } else {
          seen = new Set([h]);
          sameFor = 0;
        }
        if (sameFor >= stableFrames) return done('stable');
      }
    }
    return done('timeout');
  }

  /**
   * Presses a key repeatedly the way a reader advances a visual novel, and
   * captures each page. After a press it waits for the screen to change, then
   * to settle; black screens do not count as settled, and if the picture moves
   * again on its own shortly after settling (fades, scene changes, scripted
   * pauses) it keeps waiting. Stops early when a press changes nothing.
   */
  async advance(opts: AdvanceOptions = {}): Promise<AdvanceStep[]> {
    const steps: AdvanceStep[] = [];
    const key = opts.key ?? 'RETURN';
    const settle = opts.settleSeconds ?? 0.4;
    const maxWait = opts.maxWaitSeconds ?? 8;
    const grace = 0.8;
    for (let i = 0; i < (opts.presses ?? 1); i++) {
      const pc = this.pc();
      const t0 = pc.elapsedMs;
      const left = () => maxWait - (this.pc().elapsedMs - t0) / 1000;
      this.pressKey(key);
      await this.settle(0);
      const moved = await this.run({ seconds: maxWait, untilChanged: true });
      if (moved.outcome === 'powered-off') break;
      const unchanged = moved.outcome !== 'changed';
      let settled = false;
      while (!unchanged && left() > 0) {
        const r = await this.run({ seconds: Math.max(left(), 0.1), untilStableSeconds: settle });
        if (r.outcome !== 'stable') break;
        const blank = isBlank(this.pc().screen().rgba);
        const again = await this.run({ seconds: blank ? Math.max(left(), 0.1) : grace, untilChanged: true });
        if (again.outcome === 'changed') continue; // still transitioning
        settled = !blank;
        break;
      }
      const screen = this.pc().screen();
      steps.push({ seconds: (this.pc().elapsedMs - t0) / 1000, settled, screen, text: this.readText(), unchanged });
      if (unchanged) break;
    }
    return steps;
  }

  /** Runs `seconds` and returns the PCM produced. Headless only: in a page the sound goes to the speakers. */
  async recordAudio(seconds: number): Promise<Int16Array> {
    const pc = this.pc();
    const chunks: Int16Array[] = [];
    let total = 0;
    pc.drainAudio();
    const frames = secondsToFrames(seconds);
    for (let i = 0; i < frames; i++) {
      if (!(await this.clock.advance(1))) break;
      const pcm = pc.drainAudio();
      chunks.push(pcm);
      total += pcm.length;
    }
    const out = new Int16Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

/** Number of pixels whose RGB differs between two same-sized RGBA frames. */
export function changedPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  const wa = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2);
  const wb = new Uint32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
  let n = 0;
  for (let i = 0; i < wa.length; i++) if (wa[i] !== wb[i]) n++;
  return n;
}

/** True when nearly every pixel has the same color (black or blank transition screens). */
export function isBlank(rgba: Uint8ClampedArray): boolean {
  const w = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >> 2);
  const first = w[0];
  let other = 0;
  for (let i = 0; i < w.length; i += 7) if (w[i] !== first) other++;
  return other < (w.length / 7) * 0.003;
}
