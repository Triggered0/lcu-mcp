import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, redactUrl } from '../src/redact.js';

const PASSWORD = 'S3cr3t-Pa55';

test('redactUrl strips the password from a CDP target URL', () => {
  const url = `https://riot:${PASSWORD}@127.0.0.1:29669/index.html`;
  const out = redactUrl(url);
  assert.ok(!out.includes(PASSWORD));
  assert.ok(out.includes('riot:***@127.0.0.1:29669'));
});

test('redactUrl leaves password-free URLs recognisable', () => {
  assert.equal(redactUrl('ws://127.0.0.1:8888/devtools/page/ABC'), 'ws://127.0.0.1:8888/devtools/page/ABC');
});

test('redactUrl returns non-URL input unchanged', () => {
  assert.equal(redactUrl('not a url'), 'not a url');
});

test('redactSecrets removes every occurrence', () => {
  const text = `connect wss://riot:${PASSWORD}@127.0.0.1:1 failed for ${PASSWORD}`;
  const out = redactSecrets(text, [PASSWORD]);
  assert.ok(!out.includes(PASSWORD));
  assert.equal(out.split('***').length - 1, 2);
});

test('redactSecrets ignores empty and non-string secrets', () => {
  assert.equal(redactSecrets('abc', ['', null, undefined]), 'abc');
  assert.equal(redactSecrets(undefined, [PASSWORD]), undefined);
});
