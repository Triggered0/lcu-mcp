import { z } from 'zod';
import { inspectStorage } from '../diagnostics/storage.js';
import { guard, ok } from './result.js';

export function registerStorageTool(server, ctx) {
  server.registerTool(
    'lol_cdp_storage',
    {
      title: 'Inspect client localStorage, sessionStorage, and feature flags',
      description:
        'Inspects the League client Chromium Embedded Framework (CEF) localStorage and sessionStorage entries. ' +
        'Extracts active client-side settings, feature flags, cached configurations, and theme preferences. ' +
        'Supports case-insensitive substring filtering on keys and values, JSON auto-parsing, and automatic redaction of auth tokens, passwords, and sensitive cookies. ' +
        'Prerequisite: Requires Chrome DevTools Protocol (CDP) enabled via Pengu Loader; check lol_status if connection fails.',
      inputSchema: {
        storageType: z
          .enum(['all', 'local', 'session'])
          .default('all')
          .describe('Storage mechanism to query'),
        filter: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter for key or value'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100)
          .describe('Maximum number of items to return per storage type'),
        parseJson: z
          .boolean()
          .default(true)
          .describe('Attempt to parse JSON-encoded strings into structured objects')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(
      async ({
        storageType = 'all',
        filter,
        limit = 100,
        parseJson = true
      } = {}) => {
        const secrets = typeof ctx.secrets === 'function' ? ctx.secrets() : (Array.isArray(ctx.secrets) ? ctx.secrets : []);
        const result = await inspectStorage(ctx.cdp, {
          storageType,
          filter,
          limit,
          parseJson,
          secrets
        });
        return ok(result);
      },
      ctx
    )
  );
}
