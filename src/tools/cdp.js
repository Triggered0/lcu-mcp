import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { listTargets } from '../cdp/discover.js';
import { CdpClient } from '../cdp/client.js';
import { guard, ok } from './result.js';

export function registerCdpTools(server, ctx) {
  server.registerTool(
    'lol_cdp_targets',
    {
      title: 'List CDP debugging targets',
      description:
        'List all active CDP debugging targets (pages, popups, background workers) exposed by the League Client.',
      inputSchema: {}
    },
    guard(async () => {
      const port = (await ctx.cdp?.getPort?.()) ?? ctx.config?.cdpPort ?? 8888;
      const listCdpTargets = ctx.listTargets ?? listTargets;
      const targets = await listCdpTargets(port);
      return ok({ port, count: targets.length, targets });
    }, ctx)
  );

  server.registerTool(
    'lol_cdp_screenshot',
    {
      title: 'Capture screenshot of the League Client',
      description:
        'Capture a screenshot of the League Client window using CDP. Returns both an MCP image content block and JSON metadata, and optionally saves to disk.',
      inputSchema: {
        targetId: z.string().optional().describe('CDP target ID to screenshot (defaults to active main page)'),
        format: z.enum(['png', 'jpeg', 'webp']).default('png').describe('Image format'),
        quality: z.number().int().min(0).max(100).optional().describe('Compression quality for jpeg/webp'),
        savePath: z.string().optional().describe('Optional file path to save screenshot on disk')
      }
    },
    guard(async ({ targetId, format = 'png', quality, savePath } = {}) => {
      const port = (await ctx.cdp?.getPort?.()) ?? ctx.config?.cdpPort ?? 8888;
      let captureScreenshot;
      let cleanup = null;

      if (targetId) {
        const listCdpTargets = ctx.listTargets ?? listTargets;
        const targets = await listCdpTargets(port);
        const target = targets.find((t) => t.id === targetId);
        if (!target) {
          throw new Error(`Target with id "${targetId}" not found`);
        }
        const createClient = ctx.createCdpClient ?? ((opts) => new CdpClient(opts));
        const targetClient = createClient({
          port,
          discover: async () => target,
          wsFactory: ctx.cdp?.wsFactory
        });
        captureScreenshot = (opts) => targetClient.captureScreenshot(opts);
        cleanup = () => targetClient.close();
      } else {
        captureScreenshot = (opts) => ctx.cdp.captureScreenshot(opts);
      }

      const screenshotOpts = { format };
      if (quality !== undefined) {
        screenshotOpts.quality = quality;
      }

      try {
        const { data, format: effectiveFormat = format } = await captureScreenshot(screenshotOpts);
        const buffer = Buffer.from(data, 'base64');
        const bytes = buffer.length;

        if (savePath) {
          const writeScreenshotFile = ctx.writeFile ?? writeFile;
          await writeScreenshotFile(savePath, buffer);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  format: effectiveFormat,
                  bytes,
                  savedTo: savePath ?? null,
                  message: 'Screenshot captured successfully'
                },
                null,
                2
              )
            },
            {
              type: 'image',
              data,
              mimeType: `image/${effectiveFormat}`
            }
          ]
        };
      } finally {
        cleanup?.();
      }
    }, ctx)
  );
}
