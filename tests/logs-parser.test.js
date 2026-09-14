import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLogLine, redactLogText } from '../src/logs/parser.js';

test('parseLogLine parses standard LeagueClient log format', () => {
  const line = '000012.345|  ERROR| Riot::Plugin::X: Failed to resolve asset';
  const baseTime = 1700000000000;
  const parsed = parseLogLine(line, baseTime);

  assert.equal(parsed.elapsed, 12.345);
  assert.equal(parsed.level, 'ERROR');
  assert.equal(parsed.subsystem, null);
  assert.equal(parsed.message, 'Riot::Plugin::X: Failed to resolve asset');
  assert.equal(parsed.wallTime, 1700000012345);
});

test('parseLogLine parses subsystem tag when present', () => {
  const line = '000000.189| ALWAYS|   CFG| Command Line: ...';
  const parsed = parseLogLine(line);

  assert.equal(parsed.elapsed, 0.189);
  assert.equal(parsed.level, 'ALWAYS');
  assert.equal(parsed.subsystem, 'CFG');
  assert.equal(parsed.message, 'Command Line: ...');
});

test('parseLogLine handles non-standard or continuation lines gracefully', () => {
  const line = '    "app": { "build_number": 1 }';
  const parsed = parseLogLine(line);

  assert.equal(parsed.elapsed, null);
  assert.equal(parsed.level, 'INFO');
  assert.equal(parsed.subsystem, null);
  assert.equal(parsed.message, line);
});

test('redactLogText strips Riot auth tokens and RSO auth keys', () => {
  const text = 'Args: --riotclient-auth-token=secretToken123 --riotclient-app-port=26430 --rso_auth={"authorization-key":"secretKey456"}';
  const redacted = redactLogText(text);

  assert.ok(!redacted.includes('secretToken123'));
  assert.ok(!redacted.includes('secretKey456'));
  assert.match(redacted, /--riotclient-auth-token=\*\*\*/);
  assert.match(redacted, /--rso_auth=\*\*\*/);
});

test('redactLogText strips in-game game command line tokens', () => {
  const text = 'Command Line: "-RiotClientAuthToken=inGameToken789"';
  const redacted = redactLogText(text);

  assert.ok(!redacted.includes('inGameToken789'));
  assert.match(redacted, /-RiotClientAuthToken=\*\*\*/);
});

test('redactLogText applies redactSecrets to remove live lockfile password', () => {
  const text = 'Connected to 127.0.0.1 with Basic riot:LivePasswordXYZ';
  const redacted = redactLogText(text, ['LivePasswordXYZ']);

  assert.ok(!redacted.includes('LivePasswordXYZ'));
  assert.match(redacted, /Basic riot:\*\*\*/);
});
