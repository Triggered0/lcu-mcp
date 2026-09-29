import { checkWrite } from '../allowlist.js';

export async function sendChatMessage(ctx, { message, conversationId }) {
  let targetConvId = conversationId;

  if (!targetConvId) {
    const convsRes = await ctx.lcu.get('/lol-chat/v1/conversations');
    if (convsRes.status === 200) {
      const convs = JSON.parse(convsRes.body) || [];
      const active = convs.find((c) => c.type === 'championSelect' || c.type === 'customGame' || c.type === 'lobby');
      if (active) targetConvId = active.id;
    }
  }

  if (!targetConvId) {
    throw new Error('No active conversation found and none specified.');
  }

  const path = `/lol-chat/v1/conversations/${encodeURIComponent(targetConvId)}/messages`;
  const allowCheck = checkWrite('POST', path, ctx.config.writeAllowlist);
  if (!allowCheck.allowed) {
    throw new Error(allowCheck.message);
  }

  const payload = { body: message, type: 'chat' };
  const res = await ctx.lcu.request('POST', path, JSON.stringify(payload));
  if (res.status >= 400) {
    throw new Error(`Failed to send chat message (HTTP ${res.status}): ${res.body}`);
  }

  return {
    success: true,
    conversationId: targetConvId,
    message
  };
}

export async function setChatStatus(ctx, { availability, statusMessage }) {
  const allowCheck = checkWrite('PUT', '/lol-chat/v1/me', ctx.config.writeAllowlist);
  if (!allowCheck.allowed) {
    throw new Error(allowCheck.message);
  }

  const payload = {};
  if (availability) payload.availability = availability;
  if (statusMessage !== undefined) payload.statusMessage = statusMessage;

  const res = await ctx.lcu.request('PUT', '/lol-chat/v1/me', JSON.stringify(payload));
  if (res.status >= 400) {
    throw new Error(`Failed to update chat status (HTTP ${res.status}): ${res.body}`);
  }

  return {
    success: true,
    updated: payload
  };
}
