import { redactSecrets } from '../redact.js';

export function ok(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

export function fail(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function guard(handler, ctx) {
  return async (args, extra) => {
    try {
      return await handler(args, extra);
    } catch (err) {
      return fail(redactSecrets(err?.message ?? String(err), ctx.secrets?.() ?? []));
    }
  };
}
