import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildHarArchive } from '../src/diagnostics/har.js';
import { registerHarExportTool } from '../src/tools/forensics_har.js';
import { fakeContext } from './helpers/context.js';

async function connect(ctx) {
  const server = new McpServer({ name: 'test-har', version: '1.0.0' });
  registerHarExportTool(server, ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

test('buildHarArchive returns valid HAR 1.2 structure for empty entries', () => {
  const har = buildHarArchive([], { creatorName: 'lcu-mcp-test', creatorVersion: '0.1.0' });
  assert.equal(har.log.version, '1.2');
  assert.deepEqual(har.log.creator, { name: 'lcu-mcp-test', version: '0.1.0' });
  assert.ok(Array.isArray(har.log.entries));
  assert.equal(har.log.entries.length, 0);
});

test('buildHarArchive transforms network tailer entries into HAR 1.2 entries', () => {
  const entries = [
    {
      kind: 'request',
      requestId: 'req-1',
      method: 'GET',
      url: 'https://127.0.0.1:29669/lol-summoner/v1/current-summoner?view=mini',
      type: 'XHR',
      status: 200,
      statusText: 'OK',
      mimeType: 'application/json',
      bytes: 1024,
      startedAt: 1727610000000,
      durationMs: 42.5,
      postData: null,
      failed: false
    },
    {
      kind: 'reattach',
      previousTargetId: 'T1',
      targetId: 'T2'
    },
    {
      kind: 'request',
      requestId: 'req-2',
      method: 'POST',
      url: 'https://127.0.0.1:29669/lol-champ-select/v1/session/actions/1/complete',
      type: 'Fetch',
      status: 204,
      statusText: 'No Content',
      mimeType: 'application/json',
      bytes: 0,
      startedAt: 1727610005000,
      durationMs: 88,
      postData: '{"championId":103}',
      failed: false
    }
  ];

  const har = buildHarArchive(entries);
  assert.equal(har.log.entries.length, 2, 'reattach events must be excluded from HAR');

  const [e1, e2] = har.log.entries;

  // Entry 1 checks
  assert.equal(e1.startedDateTime, new Date(1727610000000).toISOString());
  assert.equal(e1.time, 42.5);
  assert.equal(e1.request.method, 'GET');
  assert.equal(e1.request.url, 'https://127.0.0.1:29669/lol-summoner/v1/current-summoner?view=mini');
  assert.equal(e1.request.httpVersion, 'HTTP/1.1');
  assert.deepEqual(e1.request.queryString, [{ name: 'view', value: 'mini' }]);
  assert.deepEqual(e1.cache, {});
  assert.deepEqual(e1.timings, { send: 0, wait: 42.5, receive: 0 });
  assert.equal(e1.response.status, 200);
  assert.equal(e1.response.statusText, 'OK');
  assert.equal(e1.response.content.size, 1024);
  assert.equal(e1.response.content.mimeType, 'application/json');

  // Entry 2 checks (POST with body)
  assert.equal(e2.request.method, 'POST');
  assert.ok(e2.request.postData);
  assert.equal(e2.request.postData.mimeType, 'application/json');
  assert.equal(e2.request.postData.text, '{"championId":103}');
  assert.equal(e2.request.bodySize, Buffer.byteLength('{"championId":103}', 'utf8'));
  assert.equal(e2.response.status, 204);
  assert.equal(e2.time, 88);
});

test('buildHarArchive redacts passwords in URLs and custom secrets', () => {
  const entries = [
    {
      kind: 'request',
      method: 'GET',
      url: 'https://riot:supersecret123@127.0.0.1:29669/lol-chat/v1/conversations?auth=tokenXYZ',
      status: 200,
      postData: '{"authToken":"secret-token-abc","username":"test"}'
    }
  ];

  const har = buildHarArchive(entries, { secrets: ['supersecret123', 'tokenXYZ', 'secret-token-abc'] });
  const entry = har.log.entries[0];

  assert.ok(!entry.request.url.includes('supersecret123'));
  assert.ok(!entry.request.url.includes('tokenXYZ'));
  assert.ok(entry.request.url.includes('***'));

  assert.ok(entry.request.queryString.some((q) => q.name === 'auth' && q.value === '***'));

  assert.ok(!entry.request.postData.text.includes('secret-token-abc'));
  assert.ok(entry.request.postData.text.includes('***'));
});

test('buildHarArchive redacts sensitive authorization headers, bearer tokens, and cookies', () => {
  const entries = [
    {
      kind: 'request',
      method: 'GET',
      url: 'https://127.0.0.1:29669/lol-store/v1/wallet',
      headers: {
        'Authorization': 'Basic cmlvdDp5b3VyLXBhc3N3b3Jk',
        'riot-client-auth': 'riot-secret-token-42',
        'Cookie': 'sessionId=secret-session; theme=dark; token=jwt-val',
        'X-Custom': 'normal-value'
      },
      responseHeaders: [
        { name: 'Set-Cookie', value: 'ssid=secret-cookie-val; Secure; HttpOnly' },
        { name: 'Content-Type', value: 'application/json' }
      ],
      status: 200
    },
    {
      kind: 'request',
      method: 'GET',
      url: 'https://127.0.0.1:29669/lol-settings/v1',
      headers: [
        { name: 'authorization', value: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy.sig' }
      ],
      status: 200
    }
  ];

  const har = buildHarArchive(entries);
  const [e1, e2] = har.log.entries;

  // Authorization header redaction
  const authHeader1 = e1.request.headers.find((h) => h.name.toLowerCase() === 'authorization');
  assert.ok(authHeader1);
  assert.equal(authHeader1.value, 'Basic ***');

  const riotAuthHeader = e1.request.headers.find((h) => h.name.toLowerCase() === 'riot-client-auth');
  assert.ok(riotAuthHeader);
  assert.equal(riotAuthHeader.value, '***');

  const normalHeader = e1.request.headers.find((h) => h.name === 'X-Custom');
  assert.ok(normalHeader);
  assert.equal(normalHeader.value, 'normal-value');

  // Cookies redaction in Cookie header
  const cookieHeader = e1.request.headers.find((h) => h.name.toLowerCase() === 'cookie');
  assert.ok(cookieHeader);
  assert.ok(!cookieHeader.value.includes('secret-session'));
  assert.ok(!cookieHeader.value.includes('jwt-val'));
  assert.ok(cookieHeader.value.includes('theme=dark'));

  // Response Set-Cookie redaction
  const setCookieHeader = e1.response.headers.find((h) => h.name.toLowerCase() === 'set-cookie');
  assert.ok(setCookieHeader);
  assert.ok(!setCookieHeader.value.includes('secret-cookie-val'));
  assert.ok(setCookieHeader.value.includes('***'));

  // Bearer token redaction
  const authHeader2 = e2.request.headers.find((h) => h.name.toLowerCase() === 'authorization');
  assert.ok(authHeader2);
  assert.equal(authHeader2.value, 'Bearer ***');
});

test('lol_forensics_export_har returns HAR archive structure when savePath is omitted', async () => {
  const ctx = fakeContext({
    networkTailer: {
      tail: ({ limit }) => ({
        entries: [
          {
            kind: 'request',
            requestId: '101',
            method: 'GET',
            url: 'https://127.0.0.1:29669/lol-chat/v1/me',
            status: 200,
            durationMs: 15
          }
        ],
        cursor: 1,
        dropped: 0,
        remaining: 0
      })
    },
    secrets: () => ['custom-secret']
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_forensics_export_har',
    arguments: { limit: 50 }
  });
  await client.close();

  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.log.version, '1.2');
  assert.equal(data.log.entries.length, 1);
  assert.equal(data.log.entries[0].request.url, 'https://127.0.0.1:29669/lol-chat/v1/me');
});

test('lol_forensics_export_har writes HAR to disk when savePath is provided', async () => {
  let writtenPath = null;
  let writtenData = null;

  const ctx = fakeContext({
    networkTailer: {
      tail: () => ({
        entries: [
          {
            kind: 'request',
            requestId: '202',
            method: 'GET',
            url: 'https://127.0.0.1:29669/lol-loot/v1/player-loot',
            status: 200,
            durationMs: 22
          }
        ]
      })
    },
    writeFile: async (targetPath, data) => {
      writtenPath = targetPath;
      writtenData = data;
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_forensics_export_har',
    arguments: {
      savePath: 'C:/fake/export.har'
    }
  });
  await client.close();

  assert.equal(result.isError, undefined);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.saved, true);
  assert.equal(data.path, 'C:/fake/export.har');
  assert.equal(data.entriesCount, 1);

  assert.equal(writtenPath, 'C:/fake/export.har');
  assert.ok(writtenData);
  const parsedFile = JSON.parse(writtenData);
  assert.equal(parsedFile.log.version, '1.2');
  assert.equal(parsedFile.log.entries.length, 1);
});

test('lol_forensics_export_har tool annotations match [true, false, true, false]', async () => {
  const { client } = await connect(fakeContext());
  const { tools } = await client.listTools();
  await client.close();

  const harTool = tools.find((t) => t.name === 'lol_forensics_export_har');
  assert.ok(harTool, 'Tool lol_forensics_export_har should be registered');
  assert.deepEqual(harTool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
});
