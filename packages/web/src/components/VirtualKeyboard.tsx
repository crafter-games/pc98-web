import { Key } from '@pc98-web/core';
import type { Runner } from '../runner';

/** PC-98 keys a modern keyboard lacks, plus the function row. */
const ROWS: [string, number][][] = [
  [['STOP', Key.STOP], ['COPY', Key.COPY], ['f·1', Key.F1], ['f·2', Key.F2], ['f·3', Key.F3], ['f·4', Key.F4], ['f·5', Key.F5],
    ['f·6', Key.F6], ['f·7', Key.F7], ['f·8', Key.F8], ['f·9', Key.F9], ['f·10', Key.F10]],
  [['vf·1', Key.VF1], ['vf·2', Key.VF2], ['vf·3', Key.VF3], ['vf·4', Key.VF4], ['vf·5', Key.VF5], ['ROLL UP', Key.ROLLUP],
    ['ROLL DOWN', Key.ROLLDOWN], ['HOME CLR', Key.HOME], ['HELP', Key.HELP], ['XFER', Key.XFER], ['NFER', Key.NFER]],
  [['ESC', Key.ESC], ['GRPH', Key.GRPH], ['KANA', Key.KANA], ['CAPS', Key.CAPS], ['↑', Key.UP], ['↓', Key.DOWN], ['←', Key.LEFT],
    ['→', Key.RIGHT], ['SPACE', Key.SPACE], ['RETURN', Key.RETURN]],
];

/** Lock keys toggle on the PC-98; the rest are held while pressed. */
const LOCKS = new Set<number>([Key.CAPS, Key.KANA]);

export function VirtualKeyboard({ runner }: { runner: Runner }) {
  const press = (code: number) => (e: PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    runner.pc.keyDown(code);
    if (LOCKS.has(code)) setTimeout(() => runner.pc.keyUp(code), 80);
  };
  const release = (code: number) => () => {
    if (!LOCKS.has(code)) runner.pc.keyUp(code);
  };
  return (
    <div class="vkbd" aria-label="Teclado PC-98">
      {ROWS.map((row) => (
        <div class="row">
          {row.map(([label, code]) => (
            <button type="button" tabIndex={-1} onPointerDown={press(code)} onPointerUp={release(code)} onPointerCancel={release(code)}>
              {label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
