import { guard, ok } from './result.js';

export function registerStatusTool(server, ctx) {
  server.registerTool(
    'lol_status',
    {
      title: 'League client status',
      description:
        'Inspect overall connectivity, health, and configuration status across all server subsystems (LCU REST/WebSocket, Chrome DevTools Protocol, event buffers, live game engine). ' +
        'Use this tool first when diagnosing connection failures, verifying lockfile detection, or checking effective allowlist rules and allowEval permissions. ' +
        'Behavior: Safe and read-only; requires no client write permissions.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    guard(
      async () =>
        ok({
          lcu: ctx.lcu.statusSnapshot(),
          cdp: ctx.cdp.statusSnapshot(),
          events: ctx.tap.statusSnapshot(),
          recorder: ctx.recorder.statusSnapshot(),
          console: ctx.consoleTailer.statusSnapshot(),
          network: ctx.networkTailer.statusSnapshot(),
          logs: ctx.logWatcher ? ctx.logWatcher.statusSnapshot() : null,
          game: ctx.gameClient ? await ctx.gameClient.isGameRunning().catch(() => false) : false,
          config: {
            configPath: ctx.config.configPath,
            cdpPort: ctx.config.cdpPort,
            allowEval: ctx.config.allowEval,
            eventBufferSize: ctx.config.eventBufferSize,
            writeAllowlistEntries: ctx.config.writeAllowlist.length
          }
        }),
      ctx
    )
  );
}
