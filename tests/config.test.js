import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, loadConfig, validateConfig } from '../src/config.js';

function tmpConfig(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'lcu-mcp-'));
  const path = join(dir, 'allowlist.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

test('missing config file falls back to defaults', () => {
  const config = loadConfig({ env: { LCU_MCP_CONFIG: join(tmpdir(), 'does-not-exist.json') } });
  assert.equal(config.allowEval, DEFAULTS.allowEval);
  assert.equal(config.cdpPort, 8888);
  assert.equal(config.eventBufferSize, 1000);
  assert.deepEqual(config.writeAllowlist, []);
  assert.match(config.configPath, /does-not-exist\.json$/);
});

test('config file values override defaults', () => {
  const path = tmpConfig('{"allowEval": false, "cdpPort": 9222, "writeAllowlist": ["POST /a"]}');
  const config = loadConfig({ env: { LCU_MCP_CONFIG: path } });
  assert.equal(config.allowEval, false);
  assert.equal(config.cdpPort, 9222);
  assert.equal(config.eventBufferSize, 1000);
  assert.deepEqual(config.writeAllowlist, ['POST /a']);
});

test('malformed JSON reports the config path', () => {
  const path = tmpConfig('{ not json');
  assert.throws(() => loadConfig({ env: { LCU_MCP_CONFIG: path } }), (err) => err.message.includes(path));
});

test('validateConfig rejects wrong types', () => {
  assert.throws(() => validateConfig({ cdpPort: 'eight' }), /cdpPort/);
  assert.throws(() => validateConfig({ writeAllowlist: 'POST /a' }), /writeAllowlist/);
  assert.throws(() => validateConfig({ allowEval: 'yes' }), /allowEval/);
  assert.throws(() => validateConfig({ eventBufferSize: 0 }), /eventBufferSize/);
});

test('the recorder and console defaults are applied', () => {
  const config = validateConfig({});
  assert.equal(config.wampRecordBufferSize, 20000);
  assert.equal(config.wampRecordMaxBytes, 67108864);
  assert.equal(config.wampRecordPayloadCap, 512);
  assert.deepEqual(config.wampRecordFullPayloadUris, ['/lol-gameflow/v1/gameflow-phase']);
  assert.equal(config.wampRecordFile, null);
  assert.equal(config.cdpConsoleBufferSize, 5000);
});

test('recorder sizes must be positive integers', () => {
  assert.throws(() => validateConfig({ wampRecordBufferSize: 0 }), /wampRecordBufferSize/);
  assert.throws(() => validateConfig({ wampRecordMaxBytes: -1 }), /wampRecordMaxBytes/);
  assert.throws(() => validateConfig({ wampRecordPayloadCap: 1.5 }), /wampRecordPayloadCap/);
  assert.throws(() => validateConfig({ cdpConsoleBufferSize: 'big' }), /cdpConsoleBufferSize/);
});

test('wampRecordFullPayloadUris must be an array of paths', () => {
  assert.throws(() => validateConfig({ wampRecordFullPayloadUris: '/x' }), /wampRecordFullPayloadUris/);
  assert.throws(() => validateConfig({ wampRecordFullPayloadUris: [1] }), /wampRecordFullPayloadUris/);
  assert.deepEqual(validateConfig({ wampRecordFullPayloadUris: [] }).wampRecordFullPayloadUris, []);
});

test('wampRecordFile is null or a string path', () => {
  assert.equal(validateConfig({ wampRecordFile: null }).wampRecordFile, null);
  assert.equal(validateConfig({ wampRecordFile: 'C:\\tmp\\rec.ndjson' }).wampRecordFile, 'C:\\tmp\\rec.ndjson');
  assert.throws(() => validateConfig({ wampRecordFile: 7 }), /wampRecordFile/);
});
