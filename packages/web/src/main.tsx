import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { PC98, type DriveKind } from '@pc98-web/core';
import { Runner } from './runner';
import './style.css';

type Slot = { kind: DriveKind; drive: number; label: string };
const SLOTS: Slot[] = [
  { kind: 'fdd', drive: 0, label: 'FDD 1' },
  { kind: 'fdd', drive: 1, label: 'FDD 2' },
  { kind: 'hdd', drive: 0, label: 'HDD 1' },
];

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [runner, setRunner] = useState<Runner>();
  const [running, setRunning] = useState(false);
  const [disks, setDisks] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();

  useEffect(() => {
    let r: Runner | undefined;
    PC98.create().then((pc) => {
      r = new Runner(pc, canvasRef.current!);
      r.present();
      setRunner(r);
      (window as any).pc98 = pc; // handy for debugging and browser automation
    }, (e) => setError(String(e)));
    return () => r?.dispose();
  }, []);

  const toggle = async () => {
    if (!runner) return;
    await runner.enableAudio();
    if (runner.isRunning) runner.pause(); else runner.start();
    setRunning(runner.isRunning);
    canvasRef.current?.focus();
  };

  const load = async (slot: Slot, file?: File) => {
    if (!runner || !file) return;
    runner.pc.insertDisk(slot.kind, slot.drive, file.name, new Uint8Array(await file.arrayBuffer()));
    if (slot.kind === 'hdd' || !runner.isRunning) runner.pc.reset();
    setDisks(runner.pc.mountedDisks());
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    files.forEach((f, i) => {
      const isHdd = /\.(hdi|nhd|thd|hdd)$/i.test(f.name);
      void load(isHdd ? SLOTS[2] : SLOTS[Math.min(i, 1)], f);
    });
  };

  return (
    <main onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header>
        <h1>PC-98 Web</h1>
        <span class="sub">Neko Project II · WebAssembly</span>
      </header>
      <div class="screen">
        <canvas ref={canvasRef} width={640} height={400} aria-label="Pantalla del PC-98" />
        {!running && (
          <button class="overlay" onClick={toggle} disabled={!runner}>
            {runner ? '▶ Encender' : 'Cargando…'}
          </button>
        )}
      </div>
      {error && <p class="error">{error}</p>}
      <section class="controls">
        {SLOTS.map((slot) => {
          const key = `${slot.kind}${slot.drive}`;
          return (
            <label class="drive" key={key}>
              <span>{slot.label}</span>
              <em>{disks[key] ?? 'vacío'}</em>
              <input type="file" onChange={(e) => load(slot, (e.target as HTMLInputElement).files?.[0])} />
            </label>
          );
        })}
        <button onClick={toggle} disabled={!runner}>{running ? 'Pausa' : 'Continuar'}</button>
        <button onClick={() => runner?.pc.reset()} disabled={!runner}>Reset</button>
      </section>
      <p class="hint">Arrastra imágenes .fdi .d88 .hdm .hdi aquí. Nada sale de tu navegador.</p>
    </main>
  );
}

render(<App />, document.getElementById('app')!);
