import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogReader } from '../src/logs/reader.js';
import { LogSessionFinder } from '../src/logs/sessions.js';

test('LogReader reads the last N lines without loading entire file', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-reader-'));
  try {
    const logsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(logsDir, { recursive: true });
    const logFile = join(logsDir, '2026-09-14T12-00-00_123_LeagueClient.log');

    const lines = [
      '000000.000| ALWAYS| Logging started at 2026-09-14T12:00:00.000',
      '000001.000|   OKAY| Step 1',
      '000002.000|   WARN| Warning occurred',
      '000003.000|  ERROR| Something broke',
      '000004.000|   OKAY| Finished'
    ];
    await writeFile(logFile, lines.join('\n'));

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const reader = new LogReader({ finder });

    const result = await reader.tail({ lines: 3 });
    assert.equal(result.entries.length, 3);
    assert.deepEqual(result.entries.map((e) => e.level), ['WARN', 'ERROR', 'OKAY']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogReader filters by minimum level and search text', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-reader-filter-'));
  try {
    const logsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(logsDir, { recursive: true });
    const logFile = join(logsDir, '2026-09-14T12-00-00_123_LeagueClient.log');

    const lines = [
      '000000.000| ALWAYS| Logging started at 2026-09-14T12:00:00.000',
      '000001.000|   OKAY| User login success',
      '000002.000|   WARN| Deprecated endpoint called',
      '000003.000|  ERROR| Asset download failed for summoner'
    ];
    await writeFile(logFile, lines.join('\n'));

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const reader = new LogReader({ finder });

    const errors = await reader.tail({ level: 'ERROR' });
    assert.equal(errors.entries.length, 1);
    assert.equal(errors.entries[0].level, 'ERROR');

    const searched = await reader.tail({ search: 'endpoint' });
    assert.equal(searched.entries.length, 1);
    assert.match(searched.entries[0].message, /Deprecated endpoint/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogReader reads backwards across multiple small chunks', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-reader-chunks-'));
  try {
    const logsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(logsDir, { recursive: true });
    const logFile = join(logsDir, '2026-09-14T12-00-00_123_LeagueClient.log');

    const rawLines = [
      '000000.000| ALWAYS| Logging started at 2026-09-14T12:00:00.000'
    ];
    for (let i = 1; i <= 30; i++) {
      rawLines.push(`00000${i}.000|   INFO| Event number ${i} with extra padding text to test multi-chunk boundary parsing`);
    }
    await writeFile(logFile, rawLines.join('\n') + '\n');

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    // Use tiny 64-byte chunks to force multiple backward reads across line boundaries
    const reader = new LogReader({ finder, chunkSize: 64 });

    const result = await reader.tail({ lines: 5 });
    assert.equal(result.entries.length, 5);
    assert.equal(result.entries[0].message, 'Event number 26 with extra padding text to test multi-chunk boundary parsing');
    assert.equal(result.entries[4].message, 'Event number 30 with extra padding text to test multi-chunk boundary parsing');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogReader handles empty log files cleanly', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-reader-empty-'));
  try {
    const logsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(logsDir, { recursive: true });
    const logFile = join(logsDir, '2026-09-14T12-00-00_123_LeagueClient.log');
    await writeFile(logFile, '');

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const reader = new LogReader({ finder });

    const result = await reader.tail();
    assert.equal(result.totalSize, 0);
    assert.equal(result.returned, 0);
    assert.deepEqual(result.entries, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogReader handles lines <= 0 cleanly', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-reader-zero-'));
  try {
    const logsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(logsDir, { recursive: true });
    const logFile = join(logsDir, '2026-09-14T12-00-00_123_LeagueClient.log');
    await writeFile(logFile, '000000.000| ALWAYS| Logging started at 2026-09-14T12:00:00.000\n');

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const reader = new LogReader({ finder });

    const result = await reader.tail({ lines: 0 });
    assert.equal(result.returned, 0);
    assert.deepEqual(result.entries, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogReader redacts credentials using configured secrets callback', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-reader-redact-'));
  try {
    const logsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(logsDir, { recursive: true });
    const logFile = join(logsDir, '2026-09-14T12-00-00_123_LeagueClient.log');

    const lines = [
      '000000.000| ALWAYS| Logging started at 2026-09-14T12:00:00.000',
      '000001.000|   OKAY| Auth arg: --riotclient-auth-token=superSecretToken123 with password secretPw999'
    ];
    await writeFile(logFile, lines.join('\n'));

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const reader = new LogReader({ finder, secrets: () => ['secretPw999'] });

    const result = await reader.tail({ lines: 1 });
    assert.equal(result.entries.length, 1);
    assert.ok(!result.entries[0].raw.includes('superSecretToken123'));
    assert.ok(!result.entries[0].raw.includes('secretPw999'));
    assert.match(result.entries[0].message, /--riotclient-auth-token=\*\*\*/);
    assert.match(result.entries[0].message, /password \*\*\*/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogReader resolves explicit session when requested', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-reader-session-'));
  try {
    const logsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(logsDir, { recursive: true });
    const file1 = join(logsDir, '2026-09-14T10-00-00_111_LeagueClient.log');
    const file2 = join(logsDir, '2026-09-14T12-00-00_222_LeagueClient.log');

    await writeFile(file1, '000000.000| ALWAYS| Session 1 entry\n');
    await writeFile(file2, '000000.000| ALWAYS| Session 2 entry\n');

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const reader = new LogReader({ finder });

    const result = await reader.tail({ session: '2026-09-14T10-00-00_111_LeagueClient.log' });
    assert.equal(result.entries.length, 1);
    assert.match(result.entries[0].message, /Session 1 entry/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogReader rejects cleanly when target log file does not exist', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-reader-missing-'));
  try {
    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const reader = new LogReader({ finder });

    await assert.rejects(
      () => reader.tail({ target: 'client' }),
      /No log files found for target "client"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogReader strips trailing \\r from CRLF lines', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-reader-crlf-'));
  try {
    const logsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(logsDir, { recursive: true });
    const logFile = join(logsDir, '2026-09-14T12-00-00_123_LeagueClient.log');
    await writeFile(logFile, '000000.000| ALWAYS| Initial line\r\n000001.000|   OKAY| Second line with CRLF\r\n');

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const reader = new LogReader({ finder });

    const result = await reader.tail({ lines: 2 });
    assert.equal(result.entries.length, 2);
    for (const entry of result.entries) {
      assert.ok(!entry.message.endsWith('\r'), `message ends with \\r: ${JSON.stringify(entry.message)}`);
      assert.ok(!entry.raw.endsWith('\r'), `raw ends with \\r: ${JSON.stringify(entry.raw)}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogReader strips trailing \\r even across chunk boundaries', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-reader-crlf-chunk-'));
  try {
    const logsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(logsDir, { recursive: true });
    const logFile = join(logsDir, '2026-09-14T12-00-00_123_LeagueClient.log');
    const line1 = '000000.000| ALWAYS| ' + 'A'.repeat(50) + '\r\n';
    const line2 = '000001.000|   OKAY| ' + 'B'.repeat(50) + '\r\n';
    await writeFile(logFile, line1 + line2);

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    for (let chunkSize = 50; chunkSize <= 70; chunkSize++) {
      const reader = new LogReader({ finder, chunkSize });
      const result = await reader.tail({ lines: 2 });
      assert.equal(result.entries.length, 2);
      for (const entry of result.entries) {
        assert.ok(!entry.message.endsWith('\r'), `chunkSize ${chunkSize}: message ends with \\r`);
        assert.ok(!entry.raw.endsWith('\r'), `chunkSize ${chunkSize}: raw ends with \\r`);
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


