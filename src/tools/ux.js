import { z } from 'zod';
import { fail, guard, ok } from './result.js';
import { findPageTarget, resolveCdpPort } from '../cdp/discover.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConnectionReset(err) {
  if (!err) return false;
  const msg = String(err.message ?? '');
  const code = String(err.code ?? err.cause?.code ?? '');
  return (
    code === 'ECONNRESET' ||
    code === 'UND_ERR_SOCKET' ||
    msg.includes('ECONNRESET') ||
    msg.includes('socket hang up')
  );
}

export function registerUxTools(server, ctx) {
  server.registerTool(
    'lol_restart_ux',
    {
      title: 'Restart the League Client UX',
      description:
        'Terminates and restarts the League Client UX (frontend CEF renderers) via Riot Client. ' +
        'Essential when developing Pengu Loader plugins or recovering from a frozen interface.',
      inputSchema: {
        waitForReady: z
          .boolean()
          .default(true)
          .describe('Wait until both LCU API and CDP target are fully responsive after restart'),
        timeoutSeconds: z
          .number()
          .int()
          .min(2)
          .max(60)
          .default(20)
          .describe('Maximum seconds to wait for UX readiness when waitForReady is true')
      }
    },
    guard(async ({ waitForReady = true, timeoutSeconds = 20 } = {}) => {
      // 1. Proactively disconnect CDP sockets
      try {
        ctx.cdp?.close?.();
      } catch {}
      try {
        ctx.consoleTailer?.stop?.();
      } catch {}

      // 2. Dispatch restart to LCU
      try {
        await ctx.lcu.request('POST', '/riotclient/kill-and-restart-ux', {});
      } catch (err) {
        if (!isConnectionReset(err)) throw err;
      }

      if (!waitForReady) {
        return ok({
          success: true,
          restarted: true,
          waiting: false,
          message: 'Restart command sent to Riot Client UX'
        });
      }

      const start = Date.now();
      const deadline = start + timeoutSeconds * 1000;
      const cooldownMs = ctx.cooldownMs ?? 1500;
      const pollIntervalMs = ctx.pollIntervalMs ?? 500;
      const discoverPage = ctx.discoverPage ?? findPageTarget;
      const portResolver =
        ctx.resolvePort ?? (() => resolveCdpPort({ config: ctx.config, forceRefresh: true }));

      await sleep(cooldownMs);

      let lcuReady = false;
      let cdpReady = false;
      let resolvedPort = null;
      let targetTitle = null;

      while (Date.now() < deadline) {
        if (!lcuReady) {
          try {
            const resp = await ctx.lcu.get('/riotclient/region-locale');
            if (resp && resp.status >= 200 && resp.status < 300) {
              lcuReady = true;
            }
          } catch {}
        }

        if (lcuReady && !cdpReady) {
          try {
            const portInfo = await portResolver();
            resolvedPort = typeof portInfo === 'object' && portInfo !== null ? portInfo.port : portInfo;
            const target = await discoverPage(resolvedPort);
            if (target && target.id) {
              cdpReady = true;
              targetTitle = target.title ?? null;
              break;
            }
          } catch {}
        }

        await sleep(pollIntervalMs);
      }

      const durationMs = Date.now() - start;
      if (!lcuReady || !cdpReady) {
        return fail(
          `Timed out waiting for UX readiness after ${timeoutSeconds}s. ` +
            `LCU API ready: ${lcuReady}, CDP target ready: ${cdpReady} (port ${resolvedPort}).`
        );
      }

      return ok({
        success: true,
        durationMs,
        lcuReady,
        cdpReady,
        cdpPort: resolvedPort,
        targetTitle,
        message: 'League Client UX restarted and fully responsive'
      });
    }, ctx)
  );
}
