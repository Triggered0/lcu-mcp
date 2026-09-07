import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEventFrame, decodeFrame, parseWampFrame, subscribeEndpoint } from '../src/lcu/ingest.js';

test('parseWampFrame returns endpoint payload event frame', () => {
  const raw = JSON.stringify([8, 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase', { uri: '/x' }]);
  assert.deepEqual(parseWampFrame(raw), {
    endpoint: 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
    payload: { uri: '/x' }
  });
});

test('parseWampFrame returns null for non-frames', () => {
  assert.equal(parseWampFrame(''), null);
  assert.equal(parseWampFrame('not json'), null);
  assert.equal(parseWampFrame(JSON.stringify({})), null);
  assert.equal(parseWampFrame(JSON.stringify([5, 'OnJsonApiEvent'])), null);
  assert.equal(parseWampFrame(JSON.stringify([8, 123])), null);
  assert.equal(parseWampFrame(JSON.stringify([8, 'OnJsonApiEvent'])), null);
  assert.equal(parseWampFrame(JSON.stringify([8, 'x', null])), null);
  assert.equal(parseWampFrame(JSON.stringify([8, 'x', 'nope'])), null);
});

test('parseWampFrame handles Buffer input', () => {
  const raw = Buffer.from(JSON.stringify([8, 'OnJsonApiEvent', { uri: '/x' }]));
  assert.equal(parseWampFrame(raw)?.endpoint, 'OnJsonApiEvent');
});

test('decodeEventFrame parses per-URI OnJsonApiEvent endpoint', () => {
  const raw = JSON.stringify([
    8,
    'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
    { eventType: 'Update', uri: '/lol-gameflow/v1/gameflow-phase', data: 'ChampSelect' }
  ]);
  assert.deepEqual(decodeEventFrame(raw), {
    endpoint: 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
    eventType: 'Update',
    uri: '/lol-gameflow/v1/gameflow-phase',
    data: 'ChampSelect'
  });
});

test('decodeEventFrame accepts generic OnJsonApiEvent', () => {
  const raw = JSON.stringify([8, 'OnJsonApiEvent', { eventType: 'Create', uri: '/a', data: 1 }]);
  assert.equal(decodeEventFrame(raw)?.endpoint, 'OnJsonApiEvent');
});

test('decodeEventFrame rejects endpoint not OnJsonApiEvent', () => {
  assert.equal(decodeEventFrame(JSON.stringify([8, 'OnOtherThing', { uri: '/x' }])), null);
});

// contract tests/ingest.test.js depends on, restated here so
// extraction cannot quietly widen decodeFrame without second alarm.
test('decodeFrame still rejects per-URI endpoint', () => {
  assert.equal(decodeFrame(JSON.stringify([8, 'OnJsonApiEvent_x', { uri: '/x' }])), null);
  assert.equal(decodeFrame(JSON.stringify([8, 'OnJsonApiEvent', { uri: '/x' }]))?.uri, '/x');
});

test('subscribeEndpoint replaces slash underscore', () => {
  assert.equal(
    subscribeEndpoint('/lol-gameflow/v1/gameflow-phase'),
    'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase'
  );
});
