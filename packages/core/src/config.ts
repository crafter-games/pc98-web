/** High-level machine configuration, translated to NP2's ini keys (native/src/wasm/ini.c). */
export type SoundBoard = 'none' | '14' | '26k' | '86' | '26k+86' | '86+chibi' | '118' | 'spb';

export interface MachineConfig {
  /** 'i386' runs the IA-32 core (np21); 'i286' the lighter V30/286 core (np2). */
  cpu: 'i386' | 'i286';
  /** NP2 model string: 'VX', 'VM', 'EPSON'. */
  model: string;
  /** Base clock in Hz: 2457600 (5/10 MHz family) or 1996800 (8 MHz family). */
  baseClock: 2457600 | 1996800;
  /** Clock multiplier: CPU MHz = baseClock * clockMultiple. */
  clockMultiple: number;
  /** Extended memory in MB (on top of 640KB conventional memory). */
  extMemoryMB: number;
  soundBoard: SoundBoard;
  /** Audio sample rate. */
  sampleRate: 22050 | 44100 | 48000;
  /** Floppy seek noise. */
  seekSound: boolean;
  /** Raw NP2 ini overrides, applied last. */
  raw?: Record<string, string | number | boolean | number[]>;
}

export const DEFAULT_CONFIG: MachineConfig = {
  cpu: 'i386',
  model: 'VX',
  baseClock: 2457600,
  clockMultiple: 8,
  extMemoryMB: 3,
  soundBoard: '86',
  sampleRate: 44100,
  seekSound: false,
};

const SOUND_SW: Record<SoundBoard, number> = {
  none: 0x00,
  '14': 0x01,
  '26k': 0x02,
  '86': 0x04,
  '26k+86': 0x06,
  '86+chibi': 0x14,
  '118': 0x08,
  spb: 0x20,
};

/** Paths inside the emulator's virtual filesystem. */
export const FS_FONT = '/np2/font.bmp';
export const FS_BIOS_DIR = '/np2/bios/';

export function toIni(config: MachineConfig): Record<string, string | number | boolean | number[]> {
  return {
    pc_model: config.model,
    clk_base: config.baseClock,
    clk_mult: config.clockMultiple,
    ExMemory: config.extMemoryMB,
    SNDboard: SOUND_SW[config.soundBoard],
    SampleHz: config.sampleRate,
    Latencys: 250,
    Seek_Snd: config.seekSound,
    fontfile: FS_FONT,
    biospath: FS_BIOS_DIR,
    use_menu: false,
    ...config.raw,
  };
}
