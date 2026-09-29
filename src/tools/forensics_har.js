import { z } from 'zod';
import { dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { buildHarArchive } from '../diagnostics/har.js';
import { guard, ok } from './result.js';

export function registerHarExportTool(server, ctx) {
  server.registerTool(
    'lol_forensics_export_har',
    {
      title: 'Export client HTTP network traffic to standard HAR (HTTP Archive) format',
      description:
        'Exports captured HTTP/HTTPS network traffic from the active network tailer into a standard HAR 1.2 archive. ' +
        'Automatically redacts sensitive authorization headers (Basic/Bearer auth, Riot auth tokens), session cookies, and credentials. ' +
        'If savePath is specified, writes the formatted HAR file directly to disk; otherwise returns the full HAR JSON structure. ' +
        'Prerequisite: Network recording must be active; call lol_cdp_network_start first to begin capturing requests.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(1000)
          .optional()
          .describe('Maximum number of network entries to include in HAR'),
        savePath: z
          .string()
          .optional()
          .describe('Optional absolute path to write .har file to disk. If omitted, returns the HAR JSON structure.')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    guard(
      async ({ limit = 1000, savePath } = {}) => {
        let networkEntries = [];
        if (ctx?.networkTailer?.tail) {
          const tailed = ctx.networkTailer.tail({ limit });
          networkEntries = Array.isArray(tailed?.entries) ? tailed.entries : [];
        }

        const secrets = typeof ctx?.secrets === 'function' ? ctx.secrets() : [];
        const archive = buildHarArchive(networkEntries, { secrets });

        if (savePath) {
          const writeHarFile = ctx?.writeFile ?? writeFile;
          if (!ctx?.writeFile) {
            await mkdir(dirname(savePath), { recursive: true });
          }
          const content = JSON.stringify(archive, null, 2);
          await writeHarFile(savePath, content, 'utf8');
          return ok({
            saved: true,
            path: savePath,
            entriesCount: archive.log.entries.length,
            sizeBytes: Buffer.byteLength(content, 'utf8'),
            creator: archive.log.creator
          });
        }

        return ok(archive);
      },
      ctx
    )
  );
}
