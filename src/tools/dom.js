import { z } from 'zod';
import { redactSecrets } from '../redact.js';
import { fail, guard, ok } from './result.js';

export function registerDomTools(server, ctx) {
  server.registerTool(
    'lol_dom_query',
    {
      title: 'Query the League client DOM',
      description:
        'Query HTML elements in the active League client Chromium Embedded Framework (CEF) UI DOM using CSS selectors. ' +
        'Use this tool to inspect live UI elements, verify modal state, or find element identifiers. ' +
        'For arbitrary JavaScript execution or state mutation in the UI page, use lol_eval instead. ' +
        'For capturing visual UI state as an image, use lol_cdp_screenshot instead. ' +
        "Prerequisite: Requires Chrome DevTools Protocol (CDP) enabled via Pengu Loader or --remote-debugging-port; check lol_status if connection fails.",
      inputSchema: {
        selector: z.string().min(1).describe('CSS selector matching target elements, e.g. ".lol-uikit-flat-button" or "#rcp-fe-viewport"'),
        all: z.boolean().optional().describe('If true, returns an array of all matching elements; if false (default), returns only the first matching element'),
        props: z
          .array(z.string())
          .optional()
          .describe('Array of additional DOM element properties or attributes to extract, e.g. ["disabled", "href", "textContent"]')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ selector, all = false, props = [] }) => ok(await ctx.cdp.domQuery(selector, { all, props })), ctx)
  );

  server.registerTool(
    'lol_eval',
    {
      title: 'Evaluate JavaScript in the client page',
      description:
        "Execute an arbitrary JavaScript expression within the League client Chromium Embedded Framework (CEF) renderer context and return the evaluated result. " +
        "Use this tool for advanced automation or reading runtime frontend properties not exposed via REST. " +
        "For safe DOM structure inspection, prefer lol_dom_query. For standard LCU REST calls, prefer lol_request or lol_get. " +
        "Behavior: Destructive and unsandboxed; bypasses the write allowlist by construction. " +
        "Security: Gated by allowEval config flag (check lol_status); calls are refused if allowEval is false. Prerequisite: Requires active CDP connection.",
      inputSchema: {
        expression: z.string().min(1).describe('A single valid JavaScript expression to evaluate (not a statement list), e.g. "window.location.href" or "document.title"'),
        awaitPromise: z.boolean().optional().describe('Whether to await resolution if the evaluated expression returns a Promise (default: false)')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    guard(async ({ expression, awaitPromise = false }) => {
      if (!ctx.config.allowEval) {
        return fail(
          'lol_eval is disabled: "allowEval" is false in ' +
            `${ctx.config.configPath}. Set it to true to enable JS evaluation, or use lol_dom_query ` +
            'and lol_request instead.'
        );
      }
      const { value, exceptionDetails } = await ctx.cdp.evaluate(expression, { awaitPromise });
      // guard() redacts text blocks in the outer result, and safeDetails provides
      // explicit inner field sanitization as defense-in-depth.
      const secrets = ctx.secrets?.() ?? [];
      const safeDetails =
        exceptionDetails === null
          ? null
          : {
              ...exceptionDetails,
              text: redactSecrets(exceptionDetails.text, secrets),
              description: redactSecrets(exceptionDetails.description, secrets)
            };
      return ok({ value, exceptionDetails: safeDetails });
    }, ctx)
  );
}
