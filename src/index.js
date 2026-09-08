#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { LcuClient } from './lcu/client.js';
import { RingBuffer } from './lcu/buffer.js';
import { LcuEventTap } from './lcu/events.js';
import { CdpClient } from './cdp/client.js';
import { WampRecorder } from './lcu/recorder.js';
import { NdjsonSink } from './lcu/ndjson.js';
import { ConsoleTailer } from './cdp/console.js';
import { registerStatusTool } from './tools/status.js';
import { registerPassthroughTools } from './tools/passthrough.js';
import { registerEndpointsTool } from './tools/endpoints.js';
import { registerEventTools } from './tools/events.js';
import { registerDomTools } from './tools/dom.js';
import { registerRecorderTools } from './tools/recorder.js';
import { registerConsoleTools } from './tools/console.js';
import { registerUxTools } from './tools/ux.js';
import { resolveCdpPort } from './cdp/discover.js';

export function buildContext({ env = process.env } = {}) {
  const config = loadConfig({ env });
  const portResolver = async ({ forceRefresh = false } = {}) => {
    const resolved = await resolveCdpPort({ config, env, forceRefresh });
    return resolved.port;
  };
  const lcu = new LcuClient({});
  const buffer = new RingBuffer(config.eventBufferSize);
  const tap = new LcuEventTap({ client: lcu, buffer });
  const cdp = new CdpClient({ portResolver });
  const recorder = new WampRecorder({ client: lcu, config });
  if (config.wampRecordFile) {
    recorder.attachSink(new NdjsonSink({ path: config.wampRecordFile }));
  }
  // Its own CDP socket: the tailer's re-attach supervisor must not be able to
  // destabilise the shared client that lol_eval and lol_dom_query use.
  const consoleCdp = new CdpClient({ portResolver });
  const consoleTailer = new ConsoleTailer({
    cdp: consoleCdp,
    config,
    secrets: () => (lcu.currentPassword() ? [lcu.currentPassword()] : [])
  });
  return {
    config,
    lcu,
    buffer,
    tap,
    cdp,
    recorder,
    consoleTailer,
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
  registerConsoleTools(server, ctx);
  registerUxTools(server, ctx);
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
