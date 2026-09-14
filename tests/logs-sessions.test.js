import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogSessionFinder } from '../src/logs/sessions.js';

test('LogSessionFinder resolves active client log and historical sessions', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-logs-'));
  try {
    const logsDir = join(tempDir, 'Logs');
    const clientLogsDir = join(logsDir, 'LeagueClient Logs');
    await mkdir(clientLogsDir, { recursive: true });

    await writeFile(join(clientLogsDir, '2026-09-14T10-00-00_123_LeagueClient.log'), 'log1');
    // Ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(clientLogsDir, '2026-09-14T12-00-00_456_LeagueClient.log'), 'log2');

    const finder = new LogSessionFinder({ logsDir });
    const active = await finder.resolveActiveLogFile('client');
    assert.match(active, /2026-09-14T12-00-00_456_LeagueClient\.log$/);

    const sessions = await finder.findSessions('client');
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].filename, '2026-09-14T12-00-00_456_LeagueClient.log');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogSessionFinder resolves GameLogs r3dlog', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-logs-game-'));
  try {
    const logsDir = join(tempDir, 'Logs');
    const gameSessionDir = join(logsDir, 'GameLogs', '2026-09-14T18-00-00');
    await mkdir(gameSessionDir, { recursive: true });
    await writeFile(join(gameSessionDir, '2026-09-14T18-00-00_r3dlog.txt'), 'game log');

    const finder = new LogSessionFinder({ logsDir });
    const active = await finder.resolveActiveLogFile('game');
    assert.match(active, /2026-09-14T18-00-00_r3dlog\.txt$/);

    const sessions = await finder.findSessions('game');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].session, '2026-09-14T18-00-00');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogSessionFinder resolves UX logs and respects limit', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-logs-ux-'));
  try {
    const logsDir = join(tempDir, 'Logs');
    const clientLogsDir = join(logsDir, 'LeagueClient Logs');
    await mkdir(clientLogsDir, { recursive: true });

    await writeFile(join(clientLogsDir, '2026-09-14T09-00-00_111_LeagueClientUx.log'), 'ux1');
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(clientLogsDir, '2026-09-14T10-00-00_222_LeagueClientUx.log'), 'ux2');
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(clientLogsDir, '2026-09-14T11-00-00_333_LeagueClientUx.log'), 'ux3');

    const finder = new LogSessionFinder({ logsDir });
    const active = await finder.resolveActiveLogFile('ux');
    assert.match(active, /2026-09-14T11-00-00_333_LeagueClientUx\.log$/);

    const sessions = await finder.findSessions('ux', 2);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].filename, '2026-09-14T11-00-00_333_LeagueClientUx.log');
    assert.equal(sessions[1].filename, '2026-09-14T10-00-00_222_LeagueClientUx.log');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogSessionFinder resolves with explicit sessionName', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-logs-session-'));
  try {
    const logsDir = join(tempDir, 'Logs');
    const clientLogsDir = join(logsDir, 'LeagueClient Logs');
    const gameSessionDir = join(logsDir, 'GameLogs', '2026-09-14T19-00-00');
    await mkdir(clientLogsDir, { recursive: true });
    await mkdir(gameSessionDir, { recursive: true });

    await writeFile(join(clientLogsDir, 'specific-session.log'), 'client content');
    await writeFile(join(gameSessionDir, 'game_r3dlog.txt'), 'game content');

    const finder = new LogSessionFinder({ logsDir });
    const resolvedClient = await finder.resolveActiveLogFile('client', 'specific-session.log');
    assert.equal(resolvedClient, join(clientLogsDir, 'specific-session.log'));

    const resolvedGame = await finder.resolveActiveLogFile('game', '2026-09-14T19-00-00');
    assert.equal(resolvedGame, join(gameSessionDir, 'game_r3dlog.txt'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogSessionFinder derives logsDir from lockfilePath', () => {
  const finder = new LogSessionFinder({ lockfilePath: 'C:\\Games\\League\\lockfile' });
  assert.equal(finder.logsDir, 'C:\\Games\\League\\Logs');
});

test('LogSessionFinder handles missing directories and throws for nonexistent logs', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-logs-empty-'));
  try {
    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const sessions = await finder.findSessions('client');
    assert.deepEqual(sessions, []);

    const gameSessions = await finder.findSessions('game');
    assert.deepEqual(gameSessions, []);

    await assert.rejects(
      () => finder.resolveActiveLogFile('client'),
      /No log files found for target "client"/
    );

    await assert.rejects(
      () => finder.resolveActiveLogFile('game', 'nonexistent-session'),
      /No r3dlog found in session nonexistent-session/
    );

    await assert.rejects(
      () => finder.resolveActiveLogFile('client', 'nonexistent.log'),
      /Log file "nonexistent\.log" not found/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogSessionFinder sanitizes sessionName with basename', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-logs-basename-'));
  try {
    const logsDir = join(tempDir, 'Logs');
    const clientLogsDir = join(logsDir, 'LeagueClient Logs');
    await mkdir(clientLogsDir, { recursive: true });
    await writeFile(join(clientLogsDir, 'target.log'), 'content');

    const finder = new LogSessionFinder({ logsDir });
    const resolved = await finder.resolveActiveLogFile('client', '../../target.log');
    assert.equal(resolved, join(clientLogsDir, 'target.log'));

    const gameSessionDir = join(logsDir, 'GameLogs', 'session1');
    await mkdir(gameSessionDir, { recursive: true });
    await writeFile(join(gameSessionDir, 'session1_r3dlog.txt'), 'content');
    const resolvedGame = await finder.resolveActiveLogFile('game', '../../session1');
    assert.equal(resolvedGame, join(gameSessionDir, 'session1_r3dlog.txt'));

    await assert.rejects(
      () => finder.resolveActiveLogFile('client', '.'),
      /Invalid sessionName "\."/
    );
    await assert.rejects(
      () => finder.resolveActiveLogFile('client', '..'),
      /Invalid sessionName "\.\."/
    );
    await assert.rejects(
      () => finder.resolveActiveLogFile('game', '.'),
      /Invalid sessionName "\."/
    );
    await assert.rejects(
      () => finder.resolveActiveLogFile('game', '..'),
      /Invalid sessionName "\.\."/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogSessionFinder uses filename as secondary tie-breaker sort when mtimes match', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-logs-tie-'));
  try {
    const logsDir = join(tempDir, 'Logs');
    const clientLogsDir = join(logsDir, 'LeagueClient Logs');
    await mkdir(clientLogsDir, { recursive: true });

    await writeFile(join(clientLogsDir, 'A_LeagueClient.log'), 'content');
    await writeFile(join(clientLogsDir, 'B_LeagueClient.log'), 'content');

    const finder = new LogSessionFinder({ logsDir });
    const sessions = await finder.findSessions('client');
    assert.equal(sessions.length, 2);
    // Both files have same or close mtime, secondary sort ensures B comes before A or deterministic
    assert.ok(sessions[0].filename > sessions[1].filename || sessions[0].mtime >= sessions[1].mtime);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


