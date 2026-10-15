import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_CONFIG, type MachineConfig, type SoundBoard } from '@pc98-web/core';
import type { Machine } from '../machine';
import { ROM_FILES, type DisplaySettings } from '../storage';

const SOUND_BOARDS: [SoundBoard, string][] = [
  ['86', 'PC-9801-86 (YM2608, OPNA)'],
  ['26k', 'PC-9801-26K (YM2203, OPN)'],
  ['26k+86', '26K + 86'],
  ['86+chibi', '86 + Chibi-oto (PCM)'],
  ['118', 'PC-9801-118'],
  ['spb', 'Sound Blaster 16'],
  ['14', 'PC-9801-14'],
  ['none', 'Sin tarjeta'],
];

export function Settings(props: {
  machine: Machine;
  display: DisplaySettings;
  onDisplay: (d: DisplaySettings) => void;
  onClose: () => void;
  onApplied: () => void;
  guard: (fn: () => Promise<unknown>) => () => void;
}) {
  const { machine, guard } = props;
  const [cfg, setCfg] = useState<MachineConfig>({ ...DEFAULT_CONFIG, ...machine.pc.config });
  const [roms, setRoms] = useState<string[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  const romInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
    machine.storage.listRoms().then(setRoms);
  }, []);

  const set = <K extends keyof MachineConfig>(k: K, v: MachineConfig[K]) => setCfg({ ...cfg, [k]: v });
  const mhz = ((cfg.baseClock * cfg.clockMultiple) / 1e6).toFixed(1);

  return (
    <dialog ref={dialog} class="settings" onClose={props.onClose}>
      <form method="dialog">
        <h2>Ajustes</h2>

        <fieldset>
          <legend>Máquina</legend>
          <label>CPU
            <select value={cfg.cpu} onChange={(e) => set('cpu', (e.target as HTMLSelectElement).value as MachineConfig['cpu'])}>
              <option value="i386">i386 (PC-9801 clase 386)</option>
              <option value="i286">V30 / 286 (más ligero)</option>
            </select>
          </label>
          <label>Reloj: {mhz} MHz
            <input type="range" min={1} max={16} value={cfg.clockMultiple} onInput={(e) => set('clockMultiple', +(e.target as HTMLInputElement).value)} />
          </label>
          <label>Memoria extendida
            <select value={cfg.extMemoryMB} onChange={(e) => set('extMemoryMB', +(e.target as HTMLSelectElement).value)}>
              {[0, 1, 2, 3, 7, 13].map((m) => <option value={m}>{m} MB</option>)}
            </select>
          </label>
          <label>Sonido
            <select value={cfg.soundBoard} onChange={(e) => set('soundBoard', (e.target as HTMLSelectElement).value as SoundBoard)}>
              {SOUND_BOARDS.map(([v, l]) => <option value={v}>{l}</option>)}
            </select>
          </label>
          <button type="button" onClick={guard(async () => {
            await machine.boot(cfg);
            props.onApplied();
            dialog.current?.close();
          })}>Aplicar y reiniciar</button>
        </fieldset>

        <fieldset>
          <legend>Pantalla y sonido</legend>
          <label class="check"><input type="checkbox" checked={props.display.integerScale} onChange={(e) => props.onDisplay({ ...props.display, integerScale: (e.target as HTMLInputElement).checked })} /> Escalado entero (píxeles nítidos)</label>
          <label class="check"><input type="checkbox" checked={props.display.crt} onChange={(e) => props.onDisplay({ ...props.display, crt: (e.target as HTMLInputElement).checked })} /> Filtro CRT (scanlines)</label>
          <label>Volumen
            <input type="range" min={0} max={1} step={0.05} value={props.display.volume} onInput={(e) => props.onDisplay({ ...props.display, volume: +(e.target as HTMLInputElement).value })} />
          </label>
        </fieldset>

        <fieldset>
          <legend>ROMs reales (opcional)</legend>
          <p class="hint">No hacen falta: se usa la BIOS integrada de NP2 y una fuente libre. Si tienes volcados de tu propia máquina, mejoran la compatibilidad. Se guardan solo en este navegador.</p>
          <ul class="roms">
            {ROM_FILES.map((name) => (
              <li class={roms.includes(name) ? 'have' : ''}>
                {name}
                {roms.includes(name) && <button type="button" class="link danger" onClick={guard(async () => {
                  await machine.storage.deleteRom(name);
                  setRoms(await machine.storage.listRoms());
                })}>quitar</button>}
              </li>
            ))}
          </ul>
          <button type="button" class="secondary" onClick={() => romInput.current?.click()}>Añadir ROMs…</button>
          <input ref={romInput} type="file" multiple hidden onChange={(e) => {
            const input = e.target as HTMLInputElement;
            const files = [...(input.files ?? [])];
            input.value = '';
            guard(async () => {
              for (const f of files) await machine.storage.putRom(f.name, new Uint8Array(await f.arrayBuffer()));
              setRoms(await machine.storage.listRoms());
            })();
          }} />
          <p class="hint">Las ROMs se aplican al pulsar «Aplicar y reiniciar».</p>
        </fieldset>

        <div class="buttons end"><button value="close">Cerrar</button></div>
      </form>
    </dialog>
  );
}
