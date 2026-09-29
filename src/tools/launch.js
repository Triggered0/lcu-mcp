import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { fail, guard, ok } from './result.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const DEFAULT_CANDIDATE_PATHS = [
  'C:\\Riot Games\\Riot Client\\RiotClientServices.exe',
  'C:\\Riot Games\\League of Legends\\LeagueClient.exe'
];

export function findExecutable(customPath, config, fileExists = existsSync) {
  if (customPath) {
    if (fileExists(customPath)) return customPath;
    return null;
  }
  if (config?.riotClientPath && fileExists(config.riotClientPath)) {
    return config.riotClientPath;
  }
  for (const candidate of DEFAULT_CANDIDATE_PATHS) {
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

export function registerLaunchTool(server, ctx) {
  server.registerTool(
    'lol_launch_client',
    {
      title: 'Launch the League of Legends client',
      description:
        'Launch the League of Legends client via Riot Client Services or LeagueClient.exe and optionally wait until the LCU REST API becomes responsive. ' +
        'If the client is already running and responsive, returns immediately without spawning a duplicate process. ' +
        'Behavior: Safe and idempotent. ' +
        'Prerequisite: League of Legends must be installed on the system.',
      inputSchema: {
        waitForReady: z
          .boolean()
          .default(true)
          .describe('Whether to poll until the LCU REST API is fully responsive after launching (default: true)'),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(120)
          .default(30)
          .describe('Maximum seconds to wait for LCU readiness when waitForReady is true (2-120, default: 30)'),
        path: z
          .string()
          .optional()
          .describe('Optional custom path to RiotClientServices.exe or LeagueClient.exe')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ waitForReady = true, timeoutSeconds = 30, path: customPath } = {}) => {
      // 1. Check if client is already running
      try {
        const creds = await ctx.lcu.credentials();
        if (creds && creds.port) {
          const resp = await ctx.lcu.get('/riotclient/region-locale');
          if (resp && resp.status >= 200 && resp.status < 300) {
            return ok({
              success: true,
              alreadyRunning: true,
              message: 'League client is already running and responsive'
            });
          }
        }
      } catch {
        // Not running
      }

      // 2. Locate executable
      const fileExists = ctx.fileExists ?? existsSync;
      const exePath = findExecutable(customPath, ctx.config, fileExists);
      if (!exePath) {
        return fail(
          `League of Legends executable not found. Checked: ${
            customPath ? `custom path "${customPath}", ` : ''
          }${DEFAULT_CANDIDATE_PATHS.join(', ')}. Pass the "path" argument or configure "riotClientPath".`
        );
      }

      // 3. Spawn process
      const spawner = ctx.spawner ?? spawn;
      const args = exePath.toLowerCase().includes('riotclientservices')
        ? ['--launch-product=league_of_legends', '--launch-patchline=live']
        : [];

      const child = spawner(exePath, args, {
        detached: true,
        stdio: 'ignore'
      });
      child.unref?.();

      if (!waitForReady) {
        return ok({
          success: true,
          alreadyRunning: false,
          waiting: false,
          pid: child.pid,
          path: exePath,
          message: `League client launch initiated via ${exePath}`
        });
      }

      // 4. Poll for readiness
      const start = Date.now();
      const deadline = start + timeoutSeconds * 1000;
      const pollIntervalMs = ctx.pollIntervalMs ?? 1000;
      const cooldownMs = ctx.cooldownMs ?? 1000;
      const sleepFn = ctx.sleep ?? sleep;

      await sleepFn(cooldownMs);

      let lcuReady = false;
      while (Date.now() < deadline) {
        try {
          const creds = await ctx.lcu.credentials();
          if (creds && creds.port) {
            const resp = await ctx.lcu.get('/riotclient/region-locale');
            if (resp && resp.status >= 200 && resp.status < 300) {
              lcuReady = true;
              break;
            }
          }
        } catch {
          // Keep polling
        }
        await sleepFn(pollIntervalMs);
      }

      const durationMs = Date.now() - start;
      if (!lcuReady) {
        return fail(
          `Timed out waiting for League client readiness after ${timeoutSeconds}s. ` +
            'The client process was launched, but the LCU lockfile/REST API did not become responsive in time.'
        );
      }

      return ok({
        success: true,
        alreadyRunning: false,
        durationMs,
        lcuReady: true,
        path: exePath,
        message: 'League client launched and ready'
      });
    }, ctx)
  );
}
