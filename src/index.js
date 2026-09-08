#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { LcuClient } from './lcu/client.js';
import { RingBuffer } from './lcu/buffer.js';
import { LcuEventTap } from './lcu/events.js';
import { CdpClient } from './cdp/client.js';
import { WampRecorder } from './lcu/recorder.js';
import { registerStatusTool } from './tools/status.js';
import { registerPassthroughTools } from './tools/passthrough.js';
import { registerEndpointsTool } from './tools/endpoints.js';
import { registerEventTools } from './tools/events.js';
import { registerDomTools } from './tools/dom.js';
import { registerRecorderTools } from './tools/recorder.js';

export function buildContext({ env = process.env } = {}) {
  const config = loadConfig({ env });
  const lcu = new LcuClient({});
  const buffer = new RingBuffer(config.eventBufferSize);
  const tap = new LcuEventTap({ client: lcu, buffer });
  const cdp = new CdpClient({ port: config.cdpPort });
  const recorder = new WampRecorder({ client: lcu, config });
  return {
    config,
    lcu,
    buffer,
    tap,
    cdp,
    recorder,
    // The live password, for guard() to strip out of error text. No tool returns it.
    secrets: () => (lcu.currentPassword() ? [lcu.currentPassword()] : [])
  };
}

export function createServer(ctx) {
  const server = new McpServer({ name: 'lcu-mcp', version: '0.1.0' });
  registerStatusTool(server, ctx);
  registerPassthroughTools(server, ctx);
  registerEndpointsTool(server, ctx);
  registerEventTools(server, ctx);
  registerDomTools(server, ctx);
  registerRecorderTools(server, ctx);
  return server;
}

async function main() {
  const ctx = buildContext({});
  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
}

// On Windows argv[1] is a `C:\...` path while import.meta.url is a `file:///C:/...` URL.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((err) => {
    process.stderr.write(`lcu-mcp failed to start: ${err.message}\n`);
    process.exitCode = 1;
  });
}
