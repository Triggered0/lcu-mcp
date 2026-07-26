import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { DEFAULT_LOCKFILE_PATH, parseLockfile, readCredentials, watchLockfileDir } from '../src/lcu/lockfile.js';

const VALID = 'LeagueClient:26340:29669:tS8mFOfKZ-KpiUAZjs4pXQ:https';

// Never reads the real file — only checks the constant survived string escaping.
test('DEFAULT_LOCKFILE_PATH keeps its separators', () => {
  assert.equal(DEFAULT_LOCKFILE_PATH, String.raw`C:\Riot Games\League of Legends\lockfile`);
  assert.equal(win32.basename(DEFAULT_LOCKFILE_PATH), 'lockfile');
});

test('parses a valid lockfile', () => {
  const creds = parseLockfile(VALID);
  assert.deepEqual(creds, {
    name: 'LeagueClient',
    pid: 26340,
    port: 29669,
    password: 'tS8mFOfKZ-KpiUAZjs4pXQ',
    protocol: 'https'
  });
});

test('tolerates a trailing newline', () => {
  assert.equal(parseLockfile(`${VALID}\n`).port, 29669);
});

test('rejects the wrong field count', () => {
  assert.throws(() => parseLockfile('LeagueClient:26340:29669'), /5 colon-separated fields/);
});

test('rejects a non-numeric port', () => {
  assert.throws(() => parseLockfile('LeagueClient:26340:abc:pw:https'), /port/);
});

test('rejects an empty file', () => {
  assert.throws(() => parseLockfile(''), /empty/);
});

test('readCredentials reports a missing lockfile as a stopped client', async () => {
  const path = join(tmpdir(), 'lcu-mcp-absent', 'lockfile');
  await assert.rejects(readCredentials(path), /not running/);
});

test('readCredentials reads a real file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcu-mcp-'));
  const path = join(dir, 'lockfile');
  writeFileSync(path, VALID, 'utf8');
  assert.equal((await readCredentials(path)).port, 29669);
});

test('watchLockfileDir fires when the lockfile is recreated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcu-mcp-'));
  const path = join(dir, 'lockfile');
  writeFileSync(path, VALID, 'utf8');

  // Bounded: a watcher that never fires must fail the test, not hang the suite.
  const fired = new Promise((resolve) => {
    const deadline = setTimeout(() => {
      stop();
      resolve('no event within 5s');
    }, 5000);
    const stop = watchLockfileDir(path, () => {
      clearTimeout(deadline);
      stop();
      resolve(true);
    });
    setTimeout(() => {
      rmSync(path);
      writeFileSync(path, VALID.replace('29669', '1527'), 'utf8');
    }, 50);
  });

  assert.equal(await fired, true);
});
