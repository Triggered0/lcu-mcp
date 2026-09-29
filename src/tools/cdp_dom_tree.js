import { z } from 'zod';
import { inspectDomTree } from '../diagnostics/dom_tree.js';
import { guard, ok } from './result.js';

export function registerDomTreeTool(server, ctx) {
  server.registerTool(
    'lol_cdp_dom_tree',
    {
      title: 'Analyze UI modal stack, invisible backdrops, and viewport hierarchy',
      description:
        'Inspects the League client Chromium Embedded Framework (CEF) DOM hierarchy, active modal stack, invisible blocking backdrops, and current viewport plugin route. ' +
        'Identifies open dialogs (.modal-container, lol-uikit-dialog-frame, [class*="modal"]), unclosed transparent overlays blocking user clicks (frozen UI bug), active rcp-fe-lol-* plugins, and the focused element. ' +
        'Use this tool to diagnose unclickable UI buttons, stuck modals, or verify client screen state. ' +
        'Prerequisite: Requires Chrome DevTools Protocol (CDP) enabled via Pengu Loader; check lol_status if connection fails.',
      inputSchema: {
        includeOverlaysOnly: z
          .boolean()
          .default(false)
          .optional()
          .describe('If true, returns only active modals, invisible backdrops, and viewport info, omitting the general DOM hierarchy tree (default: false)'),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .optional()
          .describe('Maximum depth of DOM hierarchy tree traversal (default: 5)')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(
      async ({ includeOverlaysOnly = false, maxDepth = 5 } = {}) => {
        const result = await inspectDomTree(ctx.cdp, { includeOverlaysOnly, maxDepth });
        return ok(result);
      },
      ctx
    )
  );
}
