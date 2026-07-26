import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAuthHeader, buildRequestOptions } from '../src/lcu/client.js';

test('buildAuthHeader uses the riot username', () => {
  assert.equal(buildAuthHeader('pw'), `Basic ${Buffer.from('riot:pw').toString('base64')}`);
});

test('buildRequestOptions targets 127.0.0.1 with auth and JSON body', () => {
  const ca = readFileSync('certs/riotgames.pem');
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
