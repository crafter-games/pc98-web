import type { AdvanceOptions, KeyOptions, MachineConfig, MouseOptions, RunOptions, RunResult } from '@pc98-web/core';

export type DriveId = 'fdd1' | 'fdd2' | 'hdd1' | 'hdd2';

export interface ScreenImage { width: number; height: number; rgba: Uint8Array }

export interface AdvanceResult { seconds: number; settled: boolean; unchanged: boolean; screen: ScreenImage; text: string }

export interface DiskInfo { name: string; kind: 'fdd' | 'hdd'; bytes: number; hasSaves: boolean; drives: DriveId[] }

export interface StateInfo { name: string; savedAt: string; disks: Partial<Record<DriveId, string>> }

export type InputOp =
  | { type: 'key'; key: string; opts: KeyOptions }
  | { type: 'text'; text: string }
  | { type: 'mouse'; opts: MouseOptions };

/**
 * Where the MCP tools act: the headless machine owned by the server, or a
 * browser tab that attached to it. Every call is async so both fit.
 */
export interface Backend {
  readonly kind: 'headless' | 'browser';
  /** One line for tool results, e.g. "headless" or "browser tab (real time)". */
  readonly label: string;
  /** Emulated seconds since power-on, frame count, powered flag. */
  clock(): Promise<{ seconds: number; frames: number; powered: boolean }>;
  screenshot(): Promise<ScreenImage>;
  readText(): Promise<string>;
  /** Sends input, waits until the guest got it, then lets waitSeconds pass. */
  input(op: InputOp, waitSeconds: number): Promise<void>;
  run(opts: RunOptions): Promise<RunResult>;
  /** Presses a key repeatedly, letting the screen settle after each press. */
  advance(opts: AdvanceOptions): Promise<AdvanceResult[]>;
  listDisks(): Promise<DiskInfo[]>;
  insertDisk(drive: DriveId, name: string): Promise<{ name: string; kind: 'fdd' | 'hdd'; hasSaves: boolean }>;
  ejectDisk(drive: DriveId): Promise<void>;
  discardSaves(name: string): Promise<boolean>;
  reset(): Promise<void>;
  powerOn(config: Partial<MachineConfig>, epochMs?: number): Promise<MachineConfig>;
  saveState(name: string): Promise<string>;
  loadState(name: string): Promise<void>;
  listStates(): Promise<StateInfo[]>;
  status(): Promise<Record<string, unknown>>;
  readMemory(address: number, length: number): Promise<Uint8Array>;
  writeMemory(address: number, bytes: Uint8Array): Promise<void>;
  /** PCM of `seconds` of emulation; only headless sessions can record. */
  recordAudio(seconds: number): Promise<{ pcm: Int16Array; sampleRate: number }>;
  /** Persists guest disk writes; returns the images saved. */
  flush(): Promise<string[]>;
}
