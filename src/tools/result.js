import { redactSecrets } from '../redact.js';

export function ok(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

export function fail(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function guard(handler, ctx = {}) {
  return async (args, extra) => {
    try {
      const result = await handler(args, extra);
      const secrets = ctx?.secrets?.() ?? [];
      if (result?.content && Array.isArray(result.content) && Array.isArray(secrets) && secrets.length > 0) {
        for (const block of result.content) {
          if (block && typeof block.text === 'string') {
            block.text = redactSecrets(block.text, secrets);
          }
        }
      }
      return result;
    } catch (err) {
      return fail(redactSecrets(err?.message ?? String(err), ctx?.secrets?.() ?? []));
    }
  };
}
