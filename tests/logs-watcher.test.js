import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWatchTailer } from '../src/logs/watcher.js';
import { LogSessionFinder } from '../src/logs/sessions.js';

test('LogWatchTailer starts from EOF, captures appended lines, and polls with cursor', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-watcher-'));
  try {
    const logsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(logsDir, { recursive: true });
    const logFile = join(logsDir, '2026-09-14T12-00-00_123_LeagueClient.log');
    await writeFile(logFile, '000000.000| ALWAYS| Initial line\n');

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const watcher = new LogWatchTailer({ finder, config: { logWatchBufferSize: 100 } });

    await watcher.start({ target: 'client' });
    assert.equal(watcher.statusSnapshot().running, true);

    // Append new line
    await appendFile(logFile, '000001.000|   OKAY| Appended line 1\n000002.000|  ERROR| Appended line 2\n');
    await watcher.drain();

    const page1 = watcher.poll({ limit: 10 });
    assert.equal(page1.entries.length, 2);
    assert.equal(page1.entries[0].level, 'OKAY');
    assert.equal(page1.entries[1].level, 'ERROR');

    const page2 = watcher.poll({ cursor: page1.cursor });
    assert.equal(page2.entries.length, 0);

    await watcher.stop();
    assert.equal(watcher.statusSnapshot().running, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogWatchTailer strips trailing \\r from CRLF lines', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-watcher-crlf-'));
  try {
    const logsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(logsDir, { recursive: true });
    const logFile = join(logsDir, '2026-09-14T12-00-00_123_LeagueClient.log');
    await writeFile(logFile, '000000.000| ALWAYS| Initial line\r\n');

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const watcher = new LogWatchTailer({ finder });

    await watcher.start({ target: 'client' });

    await appendFile(logFile, '000001.000|   OKAY| Line with CRLF\r\n000002.000|   WARN| Another CRLF\r\n');
    await watcher.drain();

    const page = watcher.poll({ limit: 10 });
    assert.equal(page.entries.length, 2);
    for (const entry of page.entries) {
      assert.ok(!entry.message.endsWith('\r'), `message should not end with \\r: ${JSON.stringify(entry.message)}`);
      assert.ok(!entry.raw.endsWith('\r'), `raw should not end with \\r: ${JSON.stringify(entry.raw)}`);
    }

    await watcher.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogWatchTailer filters entries by level and search needle during poll', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-watcher-filter-'));
  try {
    const logsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(logsDir, { recursive: true });
    const logFile = join(logsDir, '2026-09-14T12-00-00_123_LeagueClient.log');
    await writeFile(logFile, '000000.000| ALWAYS| Initial line\n');

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const watcher = new LogWatchTailer({ finder });

    await watcher.start({ target: 'client' });

    await appendFile(
      logFile,
      '000001.000|   OKAY| Normal operational event\n' +
      '000002.000|   WARN| Something looks weird: findMe\n' +
      '000003.000|  ERROR| Critical database failure\n'
    );
    await watcher.drain();

    // Filter by level
    const warnPage = watcher.poll({ level: 'WARN' });
    assert.equal(warnPage.entries.length, 1);
    assert.equal(warnPage.entries[0].level, 'WARN');

    // Filter by search (case-insensitive)
    const searchPage = watcher.poll({ search: 'FINDME' });
    assert.equal(searchPage.entries.length, 1);
    assert.equal(searchPage.entries[0].level, 'WARN');

    // Filter by level 'ALL'
    const allPage = watcher.poll({ level: 'ALL' });
    assert.equal(allPage.entries.length, 3);

    await watcher.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogWatchTailer redacts credentials and secrets', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-watcher-redact-'));
  try {
    const logsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(logsDir, { recursive: true });
    const logFile = join(logsDir, '2026-09-14T12-00-00_123_LeagueClient.log');
    await writeFile(logFile, '000000.000| ALWAYS| Initial line\n');

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const watcher = new LogWatchTailer({
      finder,
      secrets: () => ['customSecretPassword']
    });

    await watcher.start({ target: 'client' });

    await appendFile(
      logFile,
      '000001.000|   OKAY| Arg: --riotclient-auth-token=superSecretToken and customSecretPassword\n'
    );
    await watcher.drain();

    const page = watcher.poll();
    assert.equal(page.entries.length, 1);
    assert.ok(!page.entries[0].raw.includes('superSecretToken'));
    assert.ok(!page.entries[0].raw.includes('customSecretPassword'));
    assert.match(page.entries[0].message, /--riotclient-auth-token=\*\*\*/);
    assert.match(page.entries[0].message, /\*\*\*/);

    await watcher.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogWatchTailer handles file rotation or truncation gracefully', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-watcher-rotate-'));
  try {
    const logsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(logsDir, { recursive: true });
    const logFile = join(logsDir, '2026-09-14T12-00-00_123_LeagueClient.log');
    await writeFile(logFile, '000000.000| ALWAYS| Initial line with a long message to advance offset size\n');

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const watcher = new LogWatchTailer({ finder });

    await watcher.start({ target: 'client' });
    const snapshotBefore = watcher.statusSnapshot();
    assert.ok(snapshotBefore.offset > 0);

    // Truncate file (simulate rotation or file wipe)
    await writeFile(logFile, '');
    await watcher.drain();

    assert.equal(watcher.statusSnapshot().offset, 0);

    // Append new line after truncation
    await appendFile(logFile, '000001.000|   OKAY| Line after rotation\n');
    await watcher.drain();

    const page = watcher.poll();
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].message, 'Line after rotation');

    await watcher.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogWatchTailer start() handles duplicate starts and target switching', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-watcher-switch-'));
  try {
    const clientLogsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(clientLogsDir, { recursive: true });
    const clientFile = join(clientLogsDir, '2026-09-14T12-00-00_123_LeagueClient.log');
    const uxFile = join(clientLogsDir, '2026-09-14T12-00-00_123_LeagueClientUx.log');
    await writeFile(clientFile, '000000.000| ALWAYS| Client initial\n');
    await writeFile(uxFile, '000000.000| ALWAYS| UX initial\n');

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const watcher = new LogWatchTailer({ finder });

    const start1 = await watcher.start({ target: 'client' });
    assert.equal(start1.alreadyRunning, false);
    assert.equal(start1.target, 'client');

    // Calling start with same target
    const start2 = await watcher.start({ target: 'client' });
    assert.equal(start2.alreadyRunning, true);
    assert.equal(start2.target, 'client');

    // Calling start with different target switches target
    const start3 = await watcher.start({ target: 'ux' });
    assert.equal(start3.alreadyRunning, false);
    assert.equal(start3.target, 'ux');

    await watcher.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LogWatchTailer poll() throws when not running', () => {
  const finder = new LogSessionFinder({ logsDir: 'C:\\fake' });
  const watcher = new LogWatchTailer({ finder });

  assert.throws(
    () => watcher.poll(),
    /Log watcher is not running\. Call lol_logs_watch_start first\./
  );
});

test('LogWatchTailer stop() cleans up and reports discarded entries', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lcu-watcher-stop-'));
  try {
    const logsDir = join(tempDir, 'Logs', 'LeagueClient Logs');
    await mkdir(logsDir, { recursive: true });
    const logFile = join(logsDir, '2026-09-14T12-00-00_123_LeagueClient.log');
    await writeFile(logFile, '000000.000| ALWAYS| Initial line\n');

    const finder = new LogSessionFinder({ logsDir: join(tempDir, 'Logs') });
    const watcher = new LogWatchTailer({ finder });

    await watcher.start({ target: 'client' });

    await appendFile(logFile, '000001.000|   OKAY| Entry 1\n000002.000|   OKAY| Entry 2\n');
    await watcher.drain();

    assert.equal(watcher.statusSnapshot().entries, 2);

    const stopResult1 = await watcher.stop();
    assert.equal(stopResult1.stopped, true);
    assert.equal(stopResult1.entriesDiscarded, 2);
    assert.equal(watcher.statusSnapshot().entries, 0);

    const stopResult2 = await watcher.stop();
    assert.equal(stopResult2.stopped, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
