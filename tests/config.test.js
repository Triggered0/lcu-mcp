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
