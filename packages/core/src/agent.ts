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
}

export interface RunResult {
  outcome: 'ran' | 'text-matched' | 'stable' | 'timeout' | 'powered-off';
  /** Emulated seconds that passed. */
  seconds: number;
}

export interface KeyOptions { shift?: boolean; ctrl?: boolean; grph?: boolean; times?: number }

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

  /** FNV-1a over the visible picture, to detect when it stops changing. */
  screenHash(): number {
    const { rgba } = this.pc().screen();
    let h = 0x811c9dc5;
    for (let i = 0; i < rgba.length; i += 4) {
      h ^= rgba[i] | (rgba[i + 1] << 8) | (rgba[i + 2] << 16);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
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
    for (let i = 0; i < (opts.times ?? 1); i++) this.pc().pressKey(code, opts);
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
    const conditional = opts.untilText !== undefined || opts.untilStableSeconds !== undefined;
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
    let lastHash = -1;
    let sameFor = 0;
    for (let ran = 0; ran < maxFrames; ran += step) {
      if (!(await this.clock.advance(Math.min(step, maxFrames - ran)))) return done('powered-off');
      if (re && re.test(this.pc().textScreen())) return done('text-matched');
      if (stableFrames) {
        const h = this.screenHash();
        sameFor = h === lastHash ? sameFor + step : 0;
        lastHash = h;
        if (sameFor >= stableFrames) return done('stable');
      }
    }
    return done('timeout');
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
