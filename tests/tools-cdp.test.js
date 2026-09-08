import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCdpTools } from '../src/tools/cdp.js';
import { createServer } from '../src/index.js';
import { fakeContext } from './helpers/context.js';

async function connect(ctx) {
  const server = new McpServer({ name: 'test-cdp', version: '1.0.0' });
  registerCdpTools(server, ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return { client, server };
}

test('lol_cdp_targets returns list of targets and count', async () => {
  const targets = [
    {
      id: 'target-1',
      type: 'page',
      title: 'League of Legends',
      url: 'https://127.0.0.1/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:8888/devtools/page/target-1'
    },
    {
      id: 'target-2',
      type: 'other',
      title: 'Worker',
      url: 'https://127.0.0.1/worker.js',
      webSocketDebuggerUrl: 'ws://127.0.0.1:8888/devtools/page/target-2'
    }
  ];

  let queriedPort = null;
  const ctx = fakeContext({
    listTargets: async (port) => {
      queriedPort = port;
      return targets;
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_cdp_targets', arguments: {} });
  assert.equal(result.isError, undefined);

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.port, 8888);
  assert.equal(payload.count, 2);
  assert.deepEqual(payload.targets, targets);
  assert.equal(queriedPort, 8888);

  await client.close();
});

test('lol_cdp_targets falls back across getPort, config.cdpPort, and 8888', async () => {
  const targets = [{ id: 'target-1', type: 'page', title: 'Main' }];

  // 1. ctx.cdp.getPort returns 9222
  let portUsed = null;
  const ctx1 = fakeContext({
    cdp: {
      ...fakeContext().cdp,
      getPort: async () => 9222
    },
    listTargets: async (port) => {
      portUsed = port;
      return targets;
    }
  });
  const { client: client1 } = await connect(ctx1);
  const res1 = await client1.callTool({ name: 'lol_cdp_targets', arguments: {} });
  assert.equal(JSON.parse(res1.content[0].text).port, 9222);
  assert.equal(portUsed, 9222);
  await client1.close();

  // 2. ctx.cdp.getPort is missing, uses ctx.config.cdpPort
  const ctx2 = fakeContext({
    config: { cdpPort: 9333 },
    cdp: {
      ...fakeContext().cdp,
      getPort: undefined
    },
    listTargets: async (port) => {
      portUsed = port;
      return targets;
    }
  });
  const { client: client2 } = await connect(ctx2);
  const res2 = await client2.callTool({ name: 'lol_cdp_targets', arguments: {} });
  assert.equal(JSON.parse(res2.content[0].text).port, 9333);
  assert.equal(portUsed, 9333);
  await client2.close();

  // 3. Fallback to 8888
  const ctx3 = fakeContext({
    config: { cdpPort: undefined },
    cdp: {
      ...fakeContext().cdp,
      getPort: undefined
    },
    listTargets: async (port) => {
      portUsed = port;
      return targets;
    }
  });
  const { client: client3 } = await connect(ctx3);
  const res3 = await client3.callTool({ name: 'lol_cdp_targets', arguments: {} });
  assert.equal(JSON.parse(res3.content[0].text).port, 8888);
  assert.equal(portUsed, 8888);
  await client3.close();
});

test('lol_cdp_targets returns error via guard if listTargets throws', async () => {
  const ctx = fakeContext({
    listTargets: async () => {
      throw new Error('CDP target discovery failed: connection refused');
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_cdp_targets', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /CDP target discovery failed/);
  await client.close();
});

test('lol_cdp_screenshot returns image and text content blocks with defaults', async () => {
  let capturedOpts = null;
  const fakePngBase64 = Buffer.from('fake-png-data').toString('base64');

  const ctx = fakeContext({
    cdp: {
      ...fakeContext().cdp,
      captureScreenshot: async (opts) => {
        capturedOpts = opts;
        return { data: fakePngBase64, format: 'png' };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({ name: 'lol_cdp_screenshot', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 2);

  // Text content block
  assert.equal(result.content[0].type, 'text');
  const metadata = JSON.parse(result.content[0].text);
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.bytes, Buffer.from(fakePngBase64, 'base64').length);
  assert.equal(metadata.savedTo, null);
  assert.equal(metadata.message, 'Screenshot captured successfully');

  // Image content block
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].data, fakePngBase64);
  assert.equal(result.content[1].mimeType, 'image/png');

  assert.deepEqual(capturedOpts, { format: 'png' });
  await client.close();
});

test('lol_cdp_screenshot forwards format and quality parameters', async () => {
  let capturedOpts = null;
  const fakeJpgBase64 = Buffer.from('fake-jpeg-data').toString('base64');

  const ctx = fakeContext({
    cdp: {
      ...fakeContext().cdp,
      captureScreenshot: async (opts) => {
        capturedOpts = opts;
        return { data: fakeJpgBase64, format: 'jpeg' };
      }
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_cdp_screenshot',
    arguments: { format: 'jpeg', quality: 75 }
  });
  assert.equal(result.isError, undefined);

  const metadata = JSON.parse(result.content[0].text);
  assert.equal(metadata.format, 'jpeg');
  assert.equal(result.content[1].mimeType, 'image/jpeg');
  assert.deepEqual(capturedOpts, { format: 'jpeg', quality: 75 });

  await client.close();
});

test('lol_cdp_screenshot saves to file when savePath is passed', async () => {
  const fakePngBase64 = Buffer.from('screenshot-binary-content').toString('base64');
  const filePath = join(tmpdir(), `test-screenshot-${Date.now()}.png`);

  const ctx = fakeContext({
    cdp: {
      ...fakeContext().cdp,
      captureScreenshot: async () => ({ data: fakePngBase64, format: 'png' })
    }
  });

  const { client } = await connect(ctx);
  try {
    const result = await client.callTool({
      name: 'lol_cdp_screenshot',
      arguments: { savePath: filePath }
    });
    assert.equal(result.isError, undefined);

    const metadata = JSON.parse(result.content[0].text);
    assert.equal(metadata.savedTo, filePath);

    const fileBuffer = await readFile(filePath);
    assert.deepEqual(fileBuffer, Buffer.from(fakePngBase64, 'base64'));
  } finally {
    await rm(filePath, { force: true });
    await client.close();
  }
});

test('lol_cdp_screenshot with targetId uses custom target client', async () => {
  const fakePngBase64 = Buffer.from('target-screenshot').toString('base64');
  let createdWithTarget = null;
  let targetCaptured = false;
  let targetClosed = false;

  const mockTarget = {
    id: 'popup-target-42',
    type: 'page',
    title: 'Custom Popup',
    webSocketDebuggerUrl: 'ws://127.0.0.1:8888/devtools/page/popup-target-42'
  };

  const ctx = fakeContext({
    listTargets: async () => [mockTarget],
    createCdpClient: (opts) => {
      createdWithTarget = opts;
      return {
        attach: async () => {},
        captureScreenshot: async (screenshotOpts) => {
          targetCaptured = true;
          return { data: fakePngBase64, format: screenshotOpts.format ?? 'png' };
        },
        close: () => {
          targetClosed = true;
        }
      };
    }
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_cdp_screenshot',
    arguments: { targetId: 'popup-target-42' }
  });
  assert.equal(result.isError, undefined);
  assert.equal(targetCaptured, true);
  assert.equal(targetClosed, true);
  assert.equal(typeof createdWithTarget.discover, 'function');
  const discovered = await createdWithTarget.discover();
  assert.deepEqual(discovered, mockTarget);

  await client.close();
});

test('lol_cdp_screenshot returns error when targetId is not found', async () => {
  const ctx = fakeContext({
    listTargets: async () => [{ id: 'other-target', type: 'page' }]
  });

  const { client } = await connect(ctx);
  const result = await client.callTool({
    name: 'lol_cdp_screenshot',
    arguments: { targetId: 'non-existent-target' }
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Target with id "non-existent-target" not found/);

  await client.close();
});

test('createServer integrates lol_cdp_targets and lol_cdp_screenshot', async () => {
  const ctx = fakeContext();
  const server = createServer(ctx);
  const client = new Client({ name: 'test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);

  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes('lol_cdp_targets'));
  assert.ok(tools.includes('lol_cdp_screenshot'));

  const targetsRes = await client.callTool({ name: 'lol_cdp_targets', arguments: {} });
  assert.equal(targetsRes.isError, undefined);
  const targetsData = JSON.parse(targetsRes.content[0].text);
  assert.equal(targetsData.count, 1);
  assert.equal(targetsData.targets[0].id, 'P1');

  const screenshotRes = await client.callTool({ name: 'lol_cdp_screenshot', arguments: {} });
  assert.equal(screenshotRes.isError, undefined);
  assert.equal(screenshotRes.content.length, 2);
  assert.equal(screenshotRes.content[1].type, 'image');

  await client.close();
});
