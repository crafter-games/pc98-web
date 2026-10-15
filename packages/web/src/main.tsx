import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Runner } from './runner';
import { Machine, SLOTS, type SlotId } from './machine';
import { DEFAULT_DISPLAY, DISK_EXT, Storage, type DiskRecord, type DisplaySettings, type StateRecord } from './storage';
import { Settings } from './components/Settings';
import { VirtualKeyboard } from './components/VirtualKeyboard';
import { AgentBridge, type BridgeState } from './agent-bridge';
import { exportBackup, importBackup } from './backup';
import './style.css';

const QUICK_SLOT = 'quick';
/** Emulated time after which the boot disk gets an automatic library cover. */
const COVER_AFTER_MS = 45_000;

function formatSize(bytes: number): string {
  return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Re-renders when the machine reports a change and returns a refresh trigger. */
function useMachineVersion(machine?: Machine): number {
  const [v, setV] = useState(0);
  useEffect(() => machine?.onChange(() => setV((x) => x + 1)), [machine]);
  return v;
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [machine, setMachine] = useState<Machine>();
  const [runner, setRunner] = useState<Runner>();
  const [running, setRunning] = useState(false);
  const [disks, setDisks] = useState<DiskRecord[]>([]);
  const [states, setStates] = useState<StateRecord[]>([]);
  const [toast, setToast] = useState<string>();
  const [error, setError] = useState<string>();
  const [display, setDisplay] = useState<DisplaySettings>(DEFAULT_DISPLAY);
  const [showSettings, setShowSettings] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const [bridge, setBridge] = useState<AgentBridge>();
  const [agent, setAgent] = useState<{ state: BridgeState; detail?: string; last?: string }>({ state: 'closed' });
  const [scale, setScale] = useState<number>();
  const version = useMachineVersion(machine);

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? undefined : t)), 2500);
  };
  const guard = (fn: () => Promise<unknown>) => () => fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    let r: Runner | undefined;
    let m: Machine | undefined;
    (async () => {
      const storage = await Storage.open();
      void Storage.requestPersistence();
      m = await Machine.create(storage);
      await m.restoreLastSession();
      const settings = await storage.getSettings();
      setDisplay({ ...DEFAULT_DISPLAY, ...settings.display });
      r = new Runner(m, canvasRef.current!);
      r.present();
      setMachine(m);
      setRunner(r);
      (window as any).pc98 = m.pc;
      (window as any).pc98machine = m;

      const b = new AgentBridge(m, r);
      b.onState = (state, detail) => setAgent((a) => ({ ...a, state, detail }));
      b.onActivity = (what) => setAgent((a) => ({ ...a, last: what }));
      setBridge(b);
      // Pairing links from pc98-mcp look like https://pc98.crafter.games/#agent=ws://127.0.0.1:8098/TOKEN
      // (also handled when pasted into an already open tab, which only changes the hash).
      const pairFromHash = () => {
        const pairing = new URLSearchParams(location.hash.slice(1)).get('agent');
        if (!pairing) return;
        history.replaceState(null, '', location.pathname + location.search); // the token is single-use
        try { b.connect(pairing); } catch (e) { setError(String(e)); }
      };
      pairFromHash();
      window.addEventListener('hashchange', pairFromHash);
    })().catch((e) => setError(String(e)));

    const flush = () => void m?.flush();
    const onHide = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      r?.dispose();
    };
  }, []);

  // Keep the play/pause button in sync when an agent starts the machine.
  useEffect(() => {
    if (agent.state !== 'attached' || !runner) return;
    const t = setInterval(() => setRunning(runner.isRunning), 500);
    return () => clearInterval(t);
  }, [agent.state, runner]);

  const connectAgent = () => {
    if (!bridge) return;
    const input = prompt('Pega el enlace que te dio el agente (ws://127.0.0.1:PUERTO/TOKEN)');
    if (!input) return;
    try { bridge.connect(input); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => {
    if (!machine) return;
    (window as any).pc98 = machine.pc;
    runner?.invalidate();
    runner?.present();
    machine.storage.listDisks().then(setDisks);
    machine.storage.listStates().then(setStates);
  }, [machine, version]);

  useEffect(() => {
    runner?.setVolume(display.volume);
  }, [runner, display.volume]);

  const updateDisplay = (d: DisplaySettings) => {
    setDisplay(d);
    void machine?.storage.patchSettings({ display: d });
  };

  // Largest whole multiple of 640x480 (400 lines shown at 4:3) that fits.
  useEffect(() => {
    if (!display.integerScale) return setScale(undefined);
    const el = screenRef.current?.parentElement;
    if (!el) return;
    const fit = () => {
      const k = Math.max(1, Math.floor(Math.min(el.clientWidth / 640, (window.innerHeight - 160) / 480)));
      setScale(k);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener('resize', fit);
    return () => { ro.disconnect(); window.removeEventListener('resize', fit); };
  }, [display.integerScale, machine]);

  // Give the boot disk a library cover once a game has been running for a while.
  useEffect(() => {
    if (!running || !machine || !runner) return;
    const t = setInterval(() => {
      if (machine.pc.elapsedMs > COVER_AFTER_MS) void machine.coverIfMissing(() => runner.thumbnail(320));
    }, 5000);
    return () => clearInterval(t);
  }, [running, machine, runner]);

  const fullscreen = () => {
    const el = screenRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().then(() => canvasRef.current?.focus());
  };

  const quickSave = guard(async () => {
    if (!machine || !runner) return;
    await machine.saveState('Guardado rápido', await runner.thumbnail(), QUICK_SLOT);
    notify('Estado guardado');
  });
  const quickLoad = guard(async () => {
    if (!machine) return;
    if (!states.some((s) => s.id === QUICK_SLOT)) return notify('No hay guardado rápido');
    await machine.loadState(QUICK_SLOT);
    notify('Estado cargado');
  });

  useEffect(() => {
    if (!runner) return;
    runner.hotkeys = { 'Ctrl+Shift+KeyS': quickSave, 'Ctrl+Shift+KeyL': quickLoad };
  });

  const toggle = async () => {
    if (!runner) return;
    await runner.enableAudio();
    if (runner.isRunning) runner.pause(); else runner.start();
    setRunning(runner.isRunning);
    canvasRef.current?.focus();
  };

  const addFiles = (files: File[]) => guard(async () => {
    const images = files.filter((f) => DISK_EXT.test(f.name));
    if (images.length !== files.length) notify('Algunos archivos no son imágenes de disco PC-98');
    if (!images.length || !machine) return;
    await machine.importFiles(images, { insert: !running });
    if (!running) machine.pc.reset();
    notify(`${images.length} disco(s) añadidos a la biblioteca`);
  })();

  useEffect(() => {
    if (!machine || !('launchQueue' in window)) return;
    (window as any).launchQueue.setConsumer(async (params: { files: FileSystemFileHandle[] }) => {
      if (params.files?.length) addFiles(await Promise.all(params.files.map((h) => h.getFile())));
    });
  }, [machine]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    addFiles([...(e.dataTransfer?.files ?? [])]);
  };

  const mountedName = (slot: SlotId) => {
    const id = machine?.mounted.get(slot);
    return id ? disks.find((d) => d.id === id)?.name : undefined;
  };

  return (
    <main onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header>
        <h1>PC-98 Web</h1>
        <span class="sub">Neko Project II · WebAssembly</span>
        <span class="store" title="Dónde se guardan tus datos">
          {machine ? (machine.storage.blobs.kind === 'opfs' ? 'Guardado local (OPFS)' : 'Guardado local (IndexedDB)') : ''}
        </span>
      </header>

      <div
        ref={screenRef}
        class={`screen${display.crt ? ' crt' : ''}`}
        style={scale ? { width: `${640 * scale}px` } : undefined}
        onDblClick={fullscreen}
      >
        <canvas ref={canvasRef} width={640} height={400} aria-label="Pantalla del PC-98" />
        {!running && (
          <button class="overlay" onClick={toggle} disabled={!runner}>
            {runner ? (machine?.pc.frames ? '▶ Continuar' : '▶ Encender') : 'Cargando…'}
          </button>
        )}
      </div>
      {error && <p class="error" onClick={() => setError(undefined)}>{error}</p>}

      <section class="controls">
        {SLOTS.map((slot) => (
          <DriveSlot
            key={slot.id}
            label={slot.label}
            current={mountedName(slot.id)}
            options={disks.filter((d) => d.kind === slot.kind)}
            onInsert={(id) => guard(() => machine!.insert(slot.id, id))()}
            onEject={() => guard(() => machine!.eject(slot.id))()}
          />
        ))}
        <div class="buttons">
          <button onClick={toggle} disabled={!runner}>{running ? 'Pausa' : 'Continuar'}</button>
          <button onClick={() => { runner?.pc.reset(); runner?.invalidate(); }} disabled={!runner}>Reset</button>
          <button onClick={quickSave} disabled={!runner} title="Ctrl+Shift+S">Guardar</button>
          <button onClick={quickLoad} disabled={!runner} title="Ctrl+Shift+L">Cargar</button>
          <button class="secondary" onClick={() => setShowKeyboard(!showKeyboard)} aria-pressed={showKeyboard}>Teclas PC-98</button>
          <button class="secondary" onClick={() => runner?.captureMouse()} disabled={!runner} title="Esc para soltarlo">Capturar ratón</button>
          <button class="secondary" onClick={fullscreen} title="Doble clic en la pantalla">Pantalla completa</button>
          <button class="secondary" onClick={() => setShowSettings(true)} disabled={!machine}>Ajustes</button>
          {agent.state === 'closed'
            ? <button class="secondary" onClick={connectAgent} disabled={!bridge}>Conectar agente</button>
            : <button class="secondary" onClick={() => bridge?.close()}>Desconectar agente</button>}
        </div>
      </section>
      {agent.state !== 'closed' && (
        <p class={`agent ${agent.state}`} role="status">
          {agent.state === 'connecting' ? 'Conectando con el agente…' : `Un agente controla esta pestaña${agent.last ? ` · última acción: ${agent.last}` : ''}`}
        </p>
      )}
      {agent.state === 'closed' && agent.detail && <p class="hint">Agente desconectado: {agent.detail}</p>}
      {showKeyboard && runner && <VirtualKeyboard runner={runner} />}
      {showSettings && machine && (
        <Settings
          machine={machine}
          display={display}
          onDisplay={updateDisplay}
          onClose={() => setShowSettings(false)}
          onApplied={() => { runner?.invalidate(); notify('Máquina reiniciada con los nuevos ajustes'); }}
          guard={guard}
        />
      )}

      {machine && runner && (
        <div class="panels">
          <Library machine={machine} disks={disks} running={running} onAdd={addFiles} notify={notify} guard={guard} />
          <States machine={machine} runner={runner} states={states} notify={notify} guard={guard} />
          <Backup machine={machine} notify={notify} guard={guard} />
        </div>
      )}
      {toast && <div class="toast" role="status">{toast}</div>}
    </main>
  );
}

function DriveSlot(props: { label: string; current?: string; options: DiskRecord[]; onInsert: (id: string) => void; onEject: () => void }) {
  return (
    <div class="drive">
      <span>{props.label}</span>
      <select
        value=""
        onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          if (v === '__eject') props.onEject(); else if (v) props.onInsert(v);
        }}
        aria-label={`Disco en ${props.label}`}
      >
        <option value="">{props.current ?? "vacío"}</option>
        {props.options.map((d) => <option value={d.id}>{d.name}</option>)}
        {props.current && <option value="__eject">⏏ Expulsar</option>}
      </select>
    </div>
  );
}

type Guard = (fn: () => Promise<unknown>) => () => void;

function Library(props: { machine: Machine; disks: DiskRecord[]; running: boolean; onAdd: (files: File[]) => void; notify: (m: string) => void; guard: Guard }) {
  const { machine, disks, guard } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const inUse = useMemo(() => new Set(machine.mounted.values()), [machine, disks]);
  return (
    <section class="panel">
      <h2>Biblioteca <small>{disks.length}</small></h2>
      <button class="secondary" onClick={() => inputRef.current?.click()}>Añadir discos…</button>
      <input ref={inputRef} type="file" multiple hidden onChange={(e) => {
        const input = e.target as HTMLInputElement;
        props.onAdd([...(input.files ?? [])]);
        input.value = '';
      }} />
      {!disks.length && <p class="hint">Arrastra imágenes .fdi .d88 .hdm .hdi aquí. Se guardan en tu navegador y nunca salen de él.</p>}
      <ul class="list">
        {disks.map((d) => (
          <li key={d.id}>
            <Cover blob={d.cover} />
            <div class="grow">
              <strong>{d.name}</strong>
              <span class="meta">{d.kind.toUpperCase()} · {formatSize(d.bytes)}{d.hasSaves ? ' · con partidas guardadas' : ''}{inUse.has(d.id) ? ' · insertado' : ''}</span>
            </div>
            {d.hasSaves && (
              <button class="link" onClick={guard(async () => {
                if (inUse.has(d.id)) return props.notify('Expúlsalo antes de restaurarlo');
                if (!confirm(`¿Borrar lo que el juego escribió en ${d.name}? Perderás sus partidas guardadas.`)) return;
                await machine.storage.discardSaves(d.id);
                props.notify('Disco restaurado al original');
                machine.refresh();
              })}>Restaurar</button>
            )}
            <button class="link danger" onClick={guard(async () => {
              if (inUse.has(d.id)) return props.notify('Expúlsalo antes de borrarlo');
              if (!confirm(`¿Borrar ${d.name} y sus partidas de este navegador?`)) return;
              await machine.storage.deleteDisk(d.id);
              machine.refresh();
            })}>Borrar</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Cover({ blob }: { blob?: Blob }) {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : undefined), [blob]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url ? <img class="cover" src={url} alt="" width={64} height={48} /> : <div class="cover" />;
}

function Thumb({ blob }: { blob?: Blob }) {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : undefined), [blob]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url ? <img src={url} alt="" width={160} height={120} /> : <div class="thumb-empty" />;
}

function States(props: { machine: Machine; runner: Runner; states: StateRecord[]; notify: (m: string) => void; guard: Guard }) {
  const { machine, runner, states, guard } = props;
  return (
    <section class="panel">
      <h2>Estados <small>{states.length}</small></h2>
      <button class="secondary" onClick={guard(async () => {
        const name = prompt('Nombre del estado', `Estado ${new Date().toLocaleString()}`);
        if (!name) return;
        await machine.saveState(name, await runner.thumbnail());
        props.notify('Estado guardado');
      })}>Guardar estado…</button>
      <ul class="states">
        {states.map((s) => (
          <li key={s.id}>
            <button class="state" onClick={guard(async () => {
              const r = await machine.loadState(s.id);
              props.notify(r.diskChanged ? 'Estado cargado (el disco cambió desde que se guardó)' : 'Estado cargado');
            })}>
              <Thumb blob={s.thumbnail} />
              <span class="name">{s.name}</span>
              <span class="meta">{formatDate(s.createdAt)}</span>
            </button>
            <button class="link danger" aria-label={`Borrar ${s.name}`} onClick={guard(async () => {
              if (!confirm(`¿Borrar el estado "${s.name}"?`)) return;
              await machine.storage.deleteState(s.id);
              machine.refresh();
            })}>Borrar</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Backup(props: { machine: Machine; notify: (m: string) => void; guard: Guard }) {
  const { machine, guard } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <section class="panel">
      <h2>Copia de seguridad</h2>
      <p class="hint">Todo vive en este navegador. Exporta un .zip para guardarlo o llevarlo a otro equipo.</p>
      <div class="buttons">
        <button class="secondary" onClick={guard(async () => {
          await machine.flush();
          download(await exportBackup(machine.storage), `pc98-web-${new Date().toISOString().slice(0, 10)}.zip`);
        })}>Exportar</button>
        <button class="secondary" onClick={() => inputRef.current?.click()}>Importar…</button>
      </div>
      <input ref={inputRef} type="file" accept=".zip" hidden onChange={(e) => {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        guard(async () => {
          const r = await importBackup(machine.storage, new Uint8Array(await file.arrayBuffer()));
          props.notify(`Importados ${r.disks} discos y ${r.states} estados`);
          machine.refresh();
        })();
      }} />
    </section>
  );
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('./sw.js');
}

render(<App />, document.getElementById('app')!);
