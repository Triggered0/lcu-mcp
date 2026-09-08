import { z } from 'zod';
import { redactSecrets } from '../redact.js';
import { fail, guard, ok } from './result.js';

export function registerDomTools(server, ctx) {
  server.registerTool(
    'lol_dom_query',
    {
      title: 'Query the League client DOM',
      description:
        'Run document.querySelector(All) inside the client UI and return a description of the ' +
        'matches (tag, id, className, trimmed text, plus any requested properties). Needs Pengu ' +
        "Loader's remote debugging port; check lol_status if it fails.",
      inputSchema: {
        selector: z.string().min(1).describe('CSS selector, e.g. ".lol-uikit-flat-button"'),
        all: z.boolean().optional().describe('true returns every match, false (default) the first'),
        props: z
          .array(z.string())
          .optional()
          .describe('extra element properties or attributes to include, e.g. ["disabled", "href"]')
      }
    },
    guard(async ({ selector, all = false, props = [] }) => ok(await ctx.cdp.domQuery(selector, { all, props })), ctx)
  );

  server.registerTool(
    'lol_eval',
    {
      title: 'Evaluate JavaScript in the client page',
      description:
        "Evaluate an expression in the client UI's own context and return its value. Because the " +
        'page can fetch any LCU endpoint from its own origin, this bypasses the write allowlist by ' +
        'construction — it is gated by the allowEval config flag, whose state lol_status reports.',
      inputSchema: {
        expression: z.string().min(1).describe('a JavaScript expression, not a statement list'),
        awaitPromise: z.boolean().optional().describe('true to await a returned promise')
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
      // guard() only redacts thrown errors, and exceptionDetails is a success
      // payload, so it has to be scrubbed here.
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
