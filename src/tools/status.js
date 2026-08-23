import { guard, ok } from './result.js';

export function registerStatusTool(server, ctx) {
  server.registerTool(
    'lol_status',
    {
      title: 'League client status',
      description:
        'Health of both subsystems: LCU (lockfile-derived port, connected state) and CDP ' +
        '(Pengu remote debugging port, attached target), plus event tap state and effective config. ' +
        'Call this first when another tool fails.',
      inputSchema: {}
    },
    guard(
      async () =>
        ok({
          lcu: ctx.lcu.statusSnapshot(),
          cdp: ctx.cdp.statusSnapshot(),
          events: ctx.tap.statusSnapshot(),
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
