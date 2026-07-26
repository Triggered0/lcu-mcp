import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAuthHeader, buildRequestOptions, LcuClient } from '../src/lcu/client.js';

const CA_PATH = new URL('../certs/riotgames.pem', import.meta.url);

test('buildAuthHeader uses the riot username', () => {
  assert.equal(buildAuthHeader('pw'), `Basic ${Buffer.from('riot:pw').toString('base64')}`);
});

test('buildRequestOptions targets 127.0.0.1 with auth and JSON body', () => {
  const ca = readFileSync(CA_PATH);
  const { options, payload } = buildRequestOptions({
    creds: { port: 29669, password: 'pw' },
    method: 'post',
    path: '/lol-lobby/v2/lobby',
    body: { queueId: 430 },
    ca
  });

  assert.equal(options.hostname, '127.0.0.1');
  assert.equal(options.port, 29669);
  assert.equal(options.method, 'POST');
  assert.equal(options.path, '/lol-lobby/v2/lobby');
  assert.equal(options.headers.Authorization, buildAuthHeader('pw'));
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.headers['Content-Length'], Buffer.byteLength('{"queueId":430}'));
  assert.equal(payload, '{"queueId":430}');
  assert.equal(options.ca, ca);
  assert.equal(options.rejectUnauthorized, undefined, 'must never opt out of verification');
});

test('buildRequestOptions omits body headers for GET', () => {
  const { options, payload } = buildRequestOptions({
    creds: { port: 1527, password: 'pw' },
    method: 'GET',
    path: '/lol-gameflow/v1/gameflow-phase'
  });
  assert.equal(payload, undefined);
  assert.equal(options.headers['Content-Type'], undefined);
});

test('buildRequestOptions rejects a path without a leading slash', () => {
  assert.throws(
    () => buildRequestOptions({ creds: { port: 1, password: 'p' }, method: 'GET', path: 'lol-summoner/v1' }),
    /must start with "\/"/
  );
});

test('LcuClient never weakens TLS verification on its agent', () => {
  const client = new LcuClient({ lockfilePath: 'C:\\nope\\lockfile', caPath: CA_PATH });
  try {
    assert.ok(
      client.agent.options.ca.toString('utf8').includes('BEGIN CERTIFICATE'),
      'agent must be constructed with the pinned CA PEM loaded'
    );
    assert.equal(
      client.agent.options.rejectUnauthorized,
      undefined,
      'agent must never opt out of verification, even via merged per-request options'
    );
  } finally {
    client.close();
  }
});
