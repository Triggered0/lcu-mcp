import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

export const DEFAULT_LOCKFILE_PATH = 'C:\\Riot Games\\League of Legends\\lockfile';

export function parseLockfile(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) throw new Error('Lockfile is empty');
  const parts = trimmed.split(':');
  if (parts.length !== 5) {
    throw new Error(`Malformed lockfile: expected 5 colon-separated fields, got ${parts.length}`);
  }
  const [name, pid, port, password, protocol] = parts;
  if (!/^\d+$/.test(port)) throw new Error(`Malformed lockfile: port "${port}" is not a number`);
  if (!/^\d+$/.test(pid)) throw new Error(`Malformed lockfile: pid "${pid}" is not a number`);
  return { name, pid: Number(pid), port: Number(port), password, protocol };
}

export async function readCredentials(path = DEFAULT_LOCKFILE_PATH) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`League client is not running: no lockfile at ${path}`);
    }
    throw new Error(`Cannot read lockfile at ${path}: ${err.message}`);
  }
  return parseLockfile(text);
}

export function watchLockfileDir(path = DEFAULT_LOCKFILE_PATH, onChange = () => {}) {
  const dir = dirname(path);
  const file = basename(path);
  const watcher = watch(dir, (_eventType, filename) => {
    if (filename === null || filename === file) onChange();
  });
  watcher.on('error', () => {});
  return () => watcher.close();
}
