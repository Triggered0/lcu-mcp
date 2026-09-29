import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildStorageExtractionScript,
  inspectStorage,
  parseStorageEntries
} from '../src/diagnostics/storage.js';
import { registerStorageTool } from '../src/tools/cdp_storage.js';
import { fakeContext } from './helpers/context.js';

async function connect(ctx) {
  const server = new McpServer({ name: 'test-storage', version: '1.0.0' });
  registerStorageTool(server, ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

test('buildStorageExtractionScript generates executable IIFE with storageType parameter', () => {
  const scriptAll = buildStorageExtractionScript({ storageType: 'all' });
  assert.ok(scriptAll.includes('localStorage'));
  assert.ok(scriptAll.includes('sessionStorage'));
  assert.ok(scriptAll.includes('"all"'));

  const scriptLocal = buildStorageExtractionScript({ storageType: 'local' });
  assert.ok(scriptLocal.includes('"local"'));
});

test('parseStorageEntries safely extracts localStorage and sessionStorage items', () => {
  const raw = {
    localStorage: [
      { key: 'theme', value: 'dark' },
      { key: 'featureFlag_v2_lobby', value: '{"enabled":true,"rollout":100}' }
    ],
    sessionStorage: [
      { key: 'currentTab', value: 'champ-select' }
    ]
  };

  const res = parseStorageEntries(raw, { storageType: 'all', parseJson: true });
  assert.equal(res.totalKeys, 3);
  assert.equal(res.matchedKeys, 3);
  assert.equal(res.localStorage.length, 2);
  assert.equal(res.sessionStorage.length, 1);
  assert.equal(res.localStorage[0].key, 'theme');
  assert.equal(res.localStorage[0].value, 'dark');
  assert.deepEqual(res.localStorage[1].value, { enabled: true, rollout: 100 });
  assert.equal(res.sessionStorage[0].key, 'currentTab');
  assert.equal(res.sessionStorage[0].value, 'champ-select');
  assert.match(res.summary, /3 total/i);
});

test('parseStorageEntries supports case-insensitive key and value filtering', () => {
  const raw = {
    localStorage: [
      { key: 'featureFlag_runes', value: 'true' },
      { key: 'featureFlag_challenges', value: 'false' },
      { key: 'riot_client_version', value: '14.19.1' },
      { key: 'user_locale', value: 'en_US' }
    ],
    sessionStorage: [
      { key: 'riot_session_state', value: 'in_queue' },
      { key: 'debug_log_flag', value: 'featureFlag_active' }
    ]
  };

  const flagFilter = parseStorageEntries(raw, { filter: 'featureflag' });
  assert.equal(flagFilter.totalKeys, 6);
  assert.equal(flagFilter.matchedKeys, 3); // 2 in local (keys), 1 in session (value)
  assert.equal(flagFilter.localStorage.length, 2);
  assert.equal(flagFilter.sessionStorage.length, 1);
  assert.equal(flagFilter.sessionStorage[0].key, 'debug_log_flag');

  const riotFilter = parseStorageEntries(raw, { filter: 'RIOT' });
  assert.equal(riotFilter.matchedKeys, 2);
  assert.equal(riotFilter.localStorage[0].key, 'riot_client_version');
  assert.equal(riotFilter.sessionStorage[0].key, 'riot_session_state');
});

test('parseStorageEntries respects storageType option (all, local, session)', () => {
  const raw = {
    localStorage: [{ key: 'localKey1', value: '1' }, { key: 'localKey2', value: '2' }],
    sessionStorage: [{ key: 'sessionKey1', value: '3' }]
  };

  const localOnly = parseStorageEntries(raw, { storageType: 'local' });
  assert.equal(localOnly.localStorage.length, 2);
  assert.equal(localOnly.sessionStorage.length, 0);
  assert.equal(localOnly.totalKeys, 2);

  const sessionOnly = parseStorageEntries(raw, { storageType: 'session' });
  assert.equal(sessionOnly.localStorage.length, 0);
  assert.equal(sessionOnly.sessionStorage.length, 1);
  assert.equal(sessionOnly.totalKeys, 1);
});

test('parseStorageEntries redacts auth tokens, passwords, and sensitive cookies from returned values', () => {
  const raw = {
    localStorage: [
      { key: 'authToken', value: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.s3cr3t.payload' },
      { key: 'user_password', value: 'PlainPassword123!' },
      { key: 'sessionCookie', value: 'session_id=abcd9876; Path=/; HttpOnly' },
      { key: 'riotClientAuthToken', value: 'super-secret-token' },
      { key: 'api_secret', value: 'secret_key_value' },
      { key: 'userProfile', value: '{"name":"Player1","password":"HiddenPass","token":"abc-tok"}' },
      { key: 'normalSetting', value: 'value-with-S3cr3t-Pa55-in-it' }
    ],
    sessionStorage: [
      { key: 'auth_header', value: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token.data' },
      { key: 'cookie_store', value: 'session=xyz; token=abc12345' }
    ]
  };

  const res = parseStorageEntries(raw, {
    storageType: 'all',
    parseJson: true,
    secrets: ['S3cr3t-Pa55']
  });

  // Sensitive key values must be completely redacted
  assert.equal(res.localStorage.find((e) => e.key === 'authToken').value, '***');
  assert.equal(res.localStorage.find((e) => e.key === 'user_password').value, '***');
  assert.equal(res.localStorage.find((e) => e.key === 'sessionCookie').value, '***');
  assert.equal(res.localStorage.find((e) => e.key === 'riotClientAuthToken').value, '***');
  assert.equal(res.localStorage.find((e) => e.key === 'api_secret').value, '***');

  // Parsed nested JSON object properties must be redacted
  const profile = res.localStorage.find((e) => e.key === 'userProfile').value;
  assert.equal(profile.name, 'Player1');
  assert.equal(profile.password, '***');
  assert.equal(profile.token, '***');

  // Secrets list must be redacted in string values
  const normal = res.localStorage.find((e) => e.key === 'normalSetting').value;
  assert.ok(!normal.includes('S3cr3t-Pa55'));
  assert.ok(normal.includes('***'));

  // Session storage sensitive bearer tokens and cookies must be redacted
  const bearerVal = res.sessionStorage.find((e) => e.key === 'auth_header').value;
  assert.ok(!bearerVal.includes('eyJhbGci'));
  assert.ok(bearerVal.includes('Bearer ***'));

  const cookieVal = res.sessionStorage.find((e) => e.key === 'cookie_store').value;
  assert.ok(cookieVal.includes('***'));
});

test('parseStorageEntries respects limit parameter per storage mechanism', () => {
  const raw = {
    localStorage: [
      { key: 'k1', value: 'v1' },
      { key: 'k2', value: 'v2' },
      { key: 'k3', value: 'v3' },
      { key: 'k4', value: 'v4' }
    ],
    sessionStorage: [
      { key: 's1', value: 'v1' },
      { key: 's2', value: 'v2' }
    ]
  };

  const res = parseStorageEntries(raw, { limit: 2 });
  assert.equal(res.localStorage.length, 2);
  assert.equal(res.sessionStorage.length, 2);
  assert.equal(res.totalKeys, 6);
  assert.equal(res.matchedKeys, 6);
});

test('parseStorageEntries handles parseJson: false and malformed JSON safely', () => {
  const raw = {
    localStorage: [
      { key: 'validJson', value: '{"flag":true}' },
      { key: 'malformedJson', value: '{not-json' },
      { key: 'plainString', value: 'simple-string' }
    ],
    sessionStorage: []
  };

  const noParse = parseStorageEntries(raw, { parseJson: false });
  assert.equal(noParse.localStorage[0].value, '{"flag":true}');

  const withParse = parseStorageEntries(raw, { parseJson: true });
  assert.deepEqual(withParse.localStorage[0].value, { flag: true });
  assert.equal(withParse.localStorage[1].value, '{not-json');
  assert.equal(withParse.localStorage[2].value, 'simple-string');
});

test('inspectStorage queries cdp and returns parsed storage entries', async () => {
  const mockCdp = {
    evaluate: async () => ({
      value: {
        localStorage: [{ key: 'locale', value: 'en_GB' }],
        sessionStorage: [{ key: 'tab', value: 'store' }]
      },
      exceptionDetails: null
    })
  };

  const res = await inspectStorage(mockCdp, { filter: 'store' });
  assert.equal(res.sessionStorage.length, 1);
  assert.equal(res.sessionStorage[0].key, 'tab');
  assert.equal(res.matchedKeys, 1);
});

test('inspectStorage throws when cdp.evaluate returns exceptionDetails or error', async () => {
  const failingCdp = {
    evaluate: async () => ({
      value: null,
      exceptionDetails: { description: 'SecurityError: Access denied to localStorage' }
    })
  };

  await assert.rejects(
    () => inspectStorage(failingCdp),
    /CDP storage inspection failed: SecurityError/
  );

  const errorValueCdp = {
    evaluate: async () => ({
      value: { error: 'Internal CEF context error' },
      exceptionDetails: null
    })
  };

  await assert.rejects(
    () => inspectStorage(errorValueCdp),
    /Storage inspection script failed: Internal CEF context error/
  );
});

test('lol_cdp_storage MCP tool executes successfully with default parameters', async () => {
  const ctx = fakeContext({
    cdp: {
      ...fakeContext().cdp,
      evaluate: async () => ({
        value: {
          localStorage: [
            { key: 'featureFlag_dx11', value: 'true' },
            { key: 'authToken', value: 'secret-token-12345' }
          ],
          sessionStorage: [
            { key: 'temp_queue_id', value: '420' }
          ]
        },
        exceptionDetails: null
      })
    }
  });

  const { client } = await connect(ctx);

  const res = await client.callTool({
    name: 'lol_cdp_storage',
    arguments: {}
  });

  assert.equal(res.isError, undefined);
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.totalKeys, 3);
  assert.equal(data.matchedKeys, 3);
  assert.equal(data.localStorage.length, 2);
  assert.equal(data.localStorage[1].key, 'authToken');
  assert.equal(data.localStorage[1].value, '***'); // redacted
  assert.match(data.summary, /3 total/i);

  await client.close();
});

test('lol_cdp_storage MCP tool supports filter and storageType arguments', async () => {
  const ctx = fakeContext({
    cdp: {
      ...fakeContext().cdp,
      evaluate: async () => ({
        value: {
          localStorage: [
            { key: 'featureFlag_dx11', value: 'true' },
            { key: 'theme', value: 'light' }
          ],
          sessionStorage: [
            { key: 'featureFlag_session', value: 'active' }
          ]
        },
        exceptionDetails: null
      })
    }
  });

  const { client } = await connect(ctx);

  const res = await client.callTool({
    name: 'lol_cdp_storage',
    arguments: { storageType: 'local', filter: 'featureFlag' }
  });

  const data = JSON.parse(res.content[0].text);
  assert.equal(data.localStorage.length, 1);
  assert.equal(data.localStorage[0].key, 'featureFlag_dx11');
  assert.equal(data.sessionStorage.length, 0);

  await client.close();
});

test('lol_cdp_storage declares annotations [true, false, true, true]', async () => {
  const ctx = fakeContext();
  const { client } = await connect(ctx);
  const tools = (await client.listTools()).tools;
  const tool = tools.find((t) => t.name === 'lol_cdp_storage');
  assert.ok(tool, 'lol_cdp_storage should be registered');
  assert.deepEqual(
    [
      tool.annotations.readOnlyHint,
      tool.annotations.destructiveHint,
      tool.annotations.idempotentHint,
      tool.annotations.openWorldHint
    ],
    [true, false, true, true]
  );
  await client.close();
});
