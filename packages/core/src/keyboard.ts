/** PC-98 keyboard scan codes and host key mappings. */

export const Key = {
  ESC: 0x00, '1': 0x01, '2': 0x02, '3': 0x03, '4': 0x04, '5': 0x05, '6': 0x06, '7': 0x07,
  '8': 0x08, '9': 0x09, '0': 0x0a, MINUS: 0x0b, CARET: 0x0c, YEN: 0x0d, BS: 0x0e, TAB: 0x0f,
  Q: 0x10, W: 0x11, E: 0x12, R: 0x13, T: 0x14, Y: 0x15, U: 0x16, I: 0x17, O: 0x18, P: 0x19,
  AT: 0x1a, LBRACKET: 0x1b, RETURN: 0x1c,
  A: 0x1d, S: 0x1e, D: 0x1f, F: 0x20, G: 0x21, H: 0x22, J: 0x23, K: 0x24, L: 0x25,
  SEMICOLON: 0x26, COLON: 0x27, RBRACKET: 0x28,
  Z: 0x29, X: 0x2a, C: 0x2b, V: 0x2c, B: 0x2d, N: 0x2e, M: 0x2f,
  COMMA: 0x30, PERIOD: 0x31, SLASH: 0x32, UNDERSCORE: 0x33, SPACE: 0x34, XFER: 0x35,
  ROLLUP: 0x36, ROLLDOWN: 0x37, INS: 0x38, DEL: 0x39, UP: 0x3a, LEFT: 0x3b, RIGHT: 0x3c,
  DOWN: 0x3d, HOME: 0x3e, HELP: 0x3f,
  NUM_MINUS: 0x40, NUM_SLASH: 0x41, NUM7: 0x42, NUM8: 0x43, NUM9: 0x44, NUM_ASTERISK: 0x45,
  NUM4: 0x46, NUM5: 0x47, NUM6: 0x48, NUM_PLUS: 0x49, NUM1: 0x4a, NUM2: 0x4b, NUM3: 0x4c,
  NUM_EQUAL: 0x4d, NUM0: 0x4e, NUM_COMMA: 0x4f, NUM_PERIOD: 0x50, NFER: 0x51,
  VF1: 0x52, VF2: 0x53, VF3: 0x54, VF4: 0x55, VF5: 0x56,
  STOP: 0x60, COPY: 0x61,
  F1: 0x62, F2: 0x63, F3: 0x64, F4: 0x65, F5: 0x66, F6: 0x67, F7: 0x68, F8: 0x69, F9: 0x6a, F10: 0x6b,
  SHIFT: 0x70, CAPS: 0x71, KANA: 0x72, GRPH: 0x73, CTRL: 0x74,
} as const;

export type KeyName = keyof typeof Key;

/** Resolves a key name ("RETURN", "F1", "a", "ENTER") to a scan code. */
export function keyCode(name: string): number | undefined {
  const aliases: Record<string, KeyName> = {
    ENTER: 'RETURN', BACKSPACE: 'BS', ESCAPE: 'ESC', DELETE: 'DEL', INSERT: 'INS',
    PAGEUP: 'ROLLDOWN', PAGEDOWN: 'ROLLUP', CONTROL: 'CTRL', ALT: 'GRPH', CLR: 'HOME',
    ARROWUP: 'UP', ARROWDOWN: 'DOWN', ARROWLEFT: 'LEFT', ARROWRIGHT: 'RIGHT',
  };
  const upper = name.toUpperCase();
  const key = (aliases[upper] ?? upper) as KeyName;
  return Key[key];
}

/** KeyboardEvent.code -> PC-98 scan code (JIS layout host keyboards map 1:1; US keyboards by position). */
export const DOM_CODE_MAP: Record<string, number> = {
  Escape: Key.ESC, Digit1: Key['1'], Digit2: Key['2'], Digit3: Key['3'], Digit4: Key['4'],
  Digit5: Key['5'], Digit6: Key['6'], Digit7: Key['7'], Digit8: Key['8'], Digit9: Key['9'],
  Digit0: Key['0'], Minus: Key.MINUS, Equal: Key.CARET, IntlYen: Key.YEN, Backspace: Key.BS,
  Tab: Key.TAB, KeyQ: Key.Q, KeyW: Key.W, KeyE: Key.E, KeyR: Key.R, KeyT: Key.T, KeyY: Key.Y,
  KeyU: Key.U, KeyI: Key.I, KeyO: Key.O, KeyP: Key.P, BracketLeft: Key.AT, BracketRight: Key.LBRACKET,
  Enter: Key.RETURN, KeyA: Key.A, KeyS: Key.S, KeyD: Key.D, KeyF: Key.F, KeyG: Key.G, KeyH: Key.H,
  KeyJ: Key.J, KeyK: Key.K, KeyL: Key.L, Semicolon: Key.SEMICOLON, Quote: Key.COLON,
  Backslash: Key.RBRACKET, KeyZ: Key.Z, KeyX: Key.X, KeyC: Key.C, KeyV: Key.V, KeyB: Key.B,
  KeyN: Key.N, KeyM: Key.M, Comma: Key.COMMA, Period: Key.PERIOD, Slash: Key.SLASH,
  IntlRo: Key.UNDERSCORE, Space: Key.SPACE, Convert: Key.XFER, NonConvert: Key.NFER,
  PageDown: Key.ROLLUP, PageUp: Key.ROLLDOWN, Insert: Key.INS, Delete: Key.DEL,
  ArrowUp: Key.UP, ArrowLeft: Key.LEFT, ArrowRight: Key.RIGHT, ArrowDown: Key.DOWN,
  Home: Key.HOME, End: Key.HELP,
  NumpadSubtract: Key.NUM_MINUS, NumpadDivide: Key.NUM_SLASH, Numpad7: Key.NUM7, Numpad8: Key.NUM8,
  Numpad9: Key.NUM9, NumpadMultiply: Key.NUM_ASTERISK, Numpad4: Key.NUM4, Numpad5: Key.NUM5,
  Numpad6: Key.NUM6, NumpadAdd: Key.NUM_PLUS, Numpad1: Key.NUM1, Numpad2: Key.NUM2, Numpad3: Key.NUM3,
  NumpadEqual: Key.NUM_EQUAL, Numpad0: Key.NUM0, NumpadComma: Key.NUM_COMMA, NumpadDecimal: Key.NUM_PERIOD,
  NumpadEnter: Key.RETURN,
  F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6, F7: Key.F7, F8: Key.F8,
  F9: Key.F9, F10: Key.F10, F11: Key.VF1, F12: Key.VF2, Pause: Key.STOP, PrintScreen: Key.COPY,
  ShiftLeft: Key.SHIFT, ShiftRight: Key.SHIFT, CapsLock: Key.CAPS, KanaMode: Key.KANA,
  AltLeft: Key.GRPH, AltRight: Key.GRPH, ControlLeft: Key.CTRL, ControlRight: Key.CTRL,
};

/** One keystroke needed to produce a character on the PC-98 JIS layout. */
export interface Stroke { code: number; shift: boolean }

const UNSHIFTED: Record<string, number> = {
  '-': Key.MINUS, '^': Key.CARET, '\\': Key.YEN, '¥': Key.YEN, '@': Key.AT, '[': Key.LBRACKET,
  ';': Key.SEMICOLON, ':': Key.COLON, ']': Key.RBRACKET, ',': Key.COMMA, '.': Key.PERIOD,
  '/': Key.SLASH, ' ': Key.SPACE, '\n': Key.RETURN, '\r': Key.RETURN, '\t': Key.TAB, '\b': Key.BS,
};
const SHIFTED: Record<string, number> = {
  '!': Key['1'], '"': Key['2'], '#': Key['3'], '$': Key['4'], '%': Key['5'], '&': Key['6'],
  "'": Key['7'], '(': Key['8'], ')': Key['9'], '=': Key.MINUS, '~': Key.CARET, '|': Key.YEN,
  '`': Key.AT, '{': Key.LBRACKET, '+': Key.SEMICOLON, '*': Key.COLON, '}': Key.RBRACKET,
  '<': Key.COMMA, '>': Key.PERIOD, '?': Key.SLASH, '_': Key.UNDERSCORE,
};

/** Maps an ASCII character to the stroke that types it, or undefined if it cannot be typed directly. */
export function strokeForChar(ch: string): Stroke | undefined {
  if (/^[a-z]$/.test(ch)) return { code: Key[ch.toUpperCase() as KeyName], shift: false };
  if (/^[A-Z]$/.test(ch)) return { code: Key[ch as KeyName], shift: true };
  if (/^[0-9]$/.test(ch)) return { code: Key[ch as KeyName], shift: false };
  if (ch in UNSHIFTED) return { code: UNSHIFTED[ch], shift: false };
  if (ch in SHIFTED) return { code: SHIFTED[ch], shift: true };
  return undefined;
}
