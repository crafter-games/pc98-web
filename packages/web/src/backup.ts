import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { Storage } from './storage';

const MANIFEST = 'pc98-web-backup.json';

/** Packs the whole local library (disks, saves, states, settings) into a zip. */
export async function exportBackup(storage: Storage): Promise<Blob> {
  const { meta, files } = await storage.dump();
  const zip: Zippable = { [MANIFEST]: strToU8(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...meta }, null, 2)) };
  // Disk images compress well; save states are already mostly zeros too.
  for (const [path, bytes] of Object.entries(files)) zip[path] = [bytes, { level: path.startsWith('thumbs/') ? 0 : 6 }];
  return new Blob([zipSync(zip) as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}

export async function importBackup(storage: Storage, zip: Uint8Array): Promise<{ disks: number; states: number }> {
  const files = unzipSync(zip);
  const manifest = files[MANIFEST];
  if (!manifest) throw new Error('This zip is not a PC-98 Web backup');
  const meta = JSON.parse(strFromU8(manifest));
  if (meta.version !== 1) throw new Error(`Unsupported backup version ${meta.version}`);
  delete files[MANIFEST];
  return storage.restore({ meta, files });
}
