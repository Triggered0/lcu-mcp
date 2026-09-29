import { z } from 'zod';
import { sendChatMessage, setChatStatus } from '../chat/client.js';
import { guard, ok } from './result.js';

export function registerChatTools(server, ctx) {
  server.registerTool(
    'lol_chat_send',
    {
      title: 'Send message into in-game or lobby chat',
      description:
        'Sends a text chat message into the active champion select, lobby, or custom game conversation, or into a specific conversation ID. ' +
        'Use this tool to communicate team plans, role preferences, or greetings during lobby or draft phases. ' +
        'For updating your summoner availability status or custom status message, use lol_chat_status instead. ' +
        'Behavior: Sends a chat message to client conversations; automatically resolves active team/lobby chat if conversationId is omitted. ' +
        'Needs "POST /lol-chat/v1/conversations/*/messages" on the write allowlist.',
      inputSchema: {
        message: z.string().min(1).max(500).describe('Text message content to send (up to 500 characters).'),
        conversationId: z.string().optional().describe('Target conversation ID. When omitted, automatically resolves active lobby or champion select chat.')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    guard(async ({ message, conversationId }) => {
      const result = await sendChatMessage(ctx, { message, conversationId });
      return ok(result);
    }, ctx)
  );

  server.registerTool(
    'lol_chat_status',
    {
      title: 'Update summoner presence and status message',
      description:
        'Updates the local player\'s chat availability ("chat", "away", "dnd", "mobile") and custom status headline text visible to friends. ' +
        'Use this tool when setting do-not-disturb, stepping away from the client, or broadcasting a custom status message. ' +
        'For sending chat messages to conversations, use lol_chat_send instead. ' +
        'Behavior: Mutates friend presence state; idempotent when setting the same presence status. ' +
        'Needs "PUT /lol-chat/v1/me" on the write allowlist.',
      inputSchema: {
        availability: z.enum(['chat', 'away', 'dnd', 'mobile']).optional().describe('Availability status ("chat", "away", "dnd", "mobile").'),
        statusMessage: z.string().max(100).optional().describe('Custom status text message displayed to friends (up to 100 characters).')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async ({ availability, statusMessage }) => {
      const result = await setChatStatus(ctx, { availability, statusMessage });
      return ok(result);
    }, ctx)
  );
}
