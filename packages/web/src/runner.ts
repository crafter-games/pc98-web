import { DOM_CODE_MAP, PC98 } from '@pc98-web/core';
import workletUrl from './pcm-worklet.js?url';

/** Most frames run in one animation tick before we give up catching up. */
const MAX_FRAMES_PER_TICK = 4;
/**
 * NP2 mixes quietly to leave headroom (FM music around -37 dBFS RMS), so the
 * page adds makeup gain and a limiter that keeps peaks from clipping.
 */
const MAKEUP_GAIN = 3;
/**
 * Games poll the key matrix about once per frame, so a press and release that
 * land between two frames would be missed. Releases are held back until a key
 * has been down for at least this many frames.
 */
const MIN_HOLD_FRAMES = 3;
/** Audio queued in the worklet beyond which we let the emulator idle a tick. */
const AUDIO_HIGH_WATER_S = 0.15;

/**
 * Drives a PC98 in real time in the browser: paces frames against the wall
 * clock, blits the screen to a canvas and streams audio to an AudioWorklet.
 */
export class Runner {
  private readonly source: { readonly pc: PC98 };
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private audio?: AudioContext;
  private node?: AudioWorkletNode;
  private gain?: GainNode;
  private volume = 0.8;
  private audioQueued = 0;
  private raf = 0;
  private lastTick = 0;
  private debtMs = 0;
  private lastVersion = -1;
  private running = false;
  private readonly cleanup: (() => void)[] = [];

  /** Hotkeys handled by the page instead of the guest (combo -> action). */
  hotkeys: Record<string, () => void> = {};

  /** source.pc may be replaced (power cycle with new settings); the runner follows it. */
  constructor(source: { readonly pc: PC98 }, canvas: HTMLCanvasElement) {
    this.source = source;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.bindInput();
  }

  get pc(): PC98 { return this.source.pc; }

  get isRunning(): boolean { return this.running; }

  /** Forces the next present() to redraw (after loading a state or swapping machines). */
  invalidate(): void { this.lastVersion = -1; }

  /** A small PNG of the current screen, for save state previews. */
  async thumbnail(width = 160): Promise<Blob> {
    const height = Math.round((width * 3) / 4);
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.canvas, 0, 0, width, height);
    return c.convertToBlob({ type: 'image/png' });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTick = performance.now();
    this.debtMs = 0;
    void this.audio?.resume();
    this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.keyQueue.length = 0;
    this.downAt.clear();
    this.pc.releaseAllKeys();
    void this.audio?.suspend();
  }

  dispose(): void {
    this.pause();
    this.cleanup.forEach((fn) => fn());
    void this.audio?.close();
  }

  /** 0..1 */
  setVolume(v: number): void {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v * MAKEUP_GAIN;
  }

  /** AudioContext must be created from a user gesture. */
  async enableAudio(): Promise<void> {
    if (this.audio) return;
    const audio = new AudioContext({ sampleRate: this.pc.sampleRate, latencyHint: 'interactive' });
    await audio.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(audio, 'pcm-player', { outputChannelCount: [2] });
    node.port.onmessage = (e) => { this.audioQueued = e.data / this.pc.sampleRate; };
    const gain = audio.createGain();
    gain.gain.value = this.volume * MAKEUP_GAIN;
    const limiter = new DynamicsCompressorNode(audio, { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.25 });
    node.connect(gain).connect(limiter).connect(audio.destination);
    this.gain = gain;
    this.audio = audio;
    this.node = node;
    if (!this.running) await audio.suspend();
  }

  private tick = (now: number) => {
    if (!this.running) return;
    this.debtMs += Math.min(now - this.lastTick, 250);
    this.lastTick = now;

    const frameMs = 1000 / 56.42;
    let frames = 0;
    if (this.audioQueued > AUDIO_HIGH_WATER_S) {
      this.debtMs = Math.min(this.debtMs, frameMs);
    }
    while (this.debtMs >= frameMs && frames < MAX_FRAMES_PER_TICK) {
      const before = this.pc.elapsedMs;
      this.pumpKeys();
      if (!this.pc.runFrame(true)) break;
      this.debtMs -= this.pc.elapsedMs - before || frameMs;
      this.pumpAudio();
      frames++;
    }
    if (frames === MAX_FRAMES_PER_TICK) this.debtMs = 0;
    this.present();
    this.raf = requestAnimationFrame(this.tick);
  };

  private pumpAudio(): void {
    const pcm = this.pc.drainAudio();
    if (this.node && pcm.length) this.node.port.postMessage(pcm, [pcm.buffer]);
  }

  /** Blits the latest frame if NP2 redrew since the last one. */
  present(): void {
    const version = this.pc.screenVersion;
    if (version === this.lastVersion) return;
    this.lastVersion = version;
    const { width, height, rgba } = this.pc.screen();
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  }

  private bindInput(): void {
    const on = <K extends keyof HTMLElementEventMap | 'visibilitychange'>(el: HTMLElement | Document, type: K, fn: (e: K extends keyof HTMLElementEventMap ? HTMLElementEventMap[K] : Event) => void) => {
      el.addEventListener(type, fn as EventListener);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener));
    };
    const canvas = this.canvas;
    canvas.tabIndex = 0;

    const key = (down: boolean) => (e: KeyboardEvent) => {
      const combo = `${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.code}`;
      const hotkey = this.hotkeys[combo];
      if (hotkey) {
        e.preventDefault();
        if (down && !e.repeat) hotkey();
        return;
      }
      const code = DOM_CODE_MAP[e.code];
      if (code === undefined || !this.running) return;
      e.preventDefault();
      if (down && e.repeat) return; // the PC-98 BIOS does its own typematic repeat
      if (down) this.keyDown(code); else this.keyUp(code);
    };
    on(canvas, 'keydown', key(true));
    on(canvas, 'keyup', key(false));
    on(canvas, 'blur', () => {
      this.keyQueue.length = 0;
      this.downAt.clear();
      this.pc.releaseAllKeys();
    });

    let buttons = { left: false, right: false };
    on(canvas, 'click', () => {
      canvas.focus();
      if (document.pointerLockElement !== canvas) {
        // Rejected when the page is not focused or locking is unsupported: keep the keyboard working.
        Promise.resolve(canvas.requestPointerLock?.()).catch(() => {});
      }
    });
    on(canvas, 'contextmenu', (e) => e.preventDefault());
    on(canvas, 'mousemove', (e) => {
      if (document.pointerLockElement === canvas) this.pc.mouseMove(e.movementX, e.movementY);
    });
    const setButton = (e: MouseEvent, down: boolean) => {
      if (document.pointerLockElement !== canvas) return;
      if (e.button === 0) buttons.left = down;
      if (e.button === 2) buttons.right = down;
      this.pc.mouseButtons(buttons.left, buttons.right);
    };
    on(canvas, 'mousedown', (e) => setButton(e, true));
    on(canvas, 'mouseup', (e) => setButton(e, false));

    on(document, 'visibilitychange', () => {
      if (document.hidden && this.running) {
        this.pause();
        this.resumeOnVisible = true;
      } else if (!document.hidden && this.resumeOnVisible) {
        this.resumeOnVisible = false;
        this.start();
      }
    });
  }

  private resumeOnVisible = false;
  private readonly downAt = new Map<number, number>();
  private readonly keyQueue: { code: number; down: boolean }[] = [];

  /** Presses a PC-98 key from page input (keyboard, on-screen keys). */
  keyDown(code: number): void {
    this.keyQueue.push({ code, down: true });
    this.pumpKeys();
  }

  /** Releases it, no sooner than MIN_HOLD_FRAMES after the press. */
  keyUp(code: number): void {
    this.keyQueue.push({ code, down: false });
    this.pumpKeys();
  }

  /**
   * Delivers queued key events in order. A release waits until its key has
   * been down long enough, and everything behind it waits too, so a quick
   * Shift+key still reaches the guest as Shift down, key, key up, Shift up.
   */
  private pumpKeys(): void {
    const now = this.pc.frames;
    while (this.keyQueue.length) {
      const ev = this.keyQueue[0];
      if (ev.down) {
        this.downAt.set(ev.code, now);
        this.pc.keyDown(ev.code);
      } else {
        const at = this.downAt.get(ev.code);
        if (at !== undefined && now - at < MIN_HOLD_FRAMES) return;
        this.downAt.delete(ev.code);
        this.pc.keyUp(ev.code);
      }
      this.keyQueue.shift();
    }
  }
}
