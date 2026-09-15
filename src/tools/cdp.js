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
        'Discover and list all active Chrome DevTools Protocol (CDP) debugging targets (pages, modals, worker contexts) exposed by the League Client. ' +
        'Use this tool to inspect available renderer contexts and discover target IDs before capturing targeted screenshots with lol_cdp_screenshot or tailing console and network. ' +
        'Behavior: Safe and read-only. Prerequisite: League client must be running with remote debugging enabled (e.g. via Pengu Loader).',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
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
        'Capture a visual screenshot image of the active League Client window or a specific renderer target using Chrome DevTools Protocol (CDP). ' +
        'When to use: When visual rendering, modal layout, or graphic verification is needed. ' +
        'When NOT to use: Do not use for automated state checks or element queries (use lol_dom_query) or API data inspection (use lol_get). ' +
        'Behavior: Safe read of visual pixels from the renderer; writes to local filesystem only when savePath is explicitly supplied. ' +
        'Prerequisite: League client must be running with remote debugging enabled; check lol_status if disconnected. ' +
        'Returns dual-payload MCP content with a base64 image data block plus structured JSON metadata (format, dimensions, byte length, savedTo path).',
      inputSchema: {
        targetId: z.string().optional().describe('Specific CDP target ID to screenshot (defaults to active main client page; query lol_cdp_targets for options)'),
        format: z.enum(['png', 'jpeg', 'webp']).default('png').describe('Image encoding format: "png" (lossless), "jpeg" (compressed), or "webp"'),
        quality: z.number().int().min(0).max(100).optional().describe('Image compression quality from 0 to 100; only applicable when format is "jpeg" or "webp"'),
        savePath: z.string().optional().describe('Optional absolute filesystem path (e.g. "C:/temp/screenshot.png") to save the screenshot on disk')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
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
