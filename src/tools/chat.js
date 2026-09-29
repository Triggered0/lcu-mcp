import { z } from 'zod';
import { sendChatMessage, setChatStatus } from '../chat/client.js';

export function registerChatTools(server, ctx) {
  server.tool(
    'lol_chat_send',
    'Send a chat message into active champion select, lobby, or direct conversation.',
    {
      message: z.string().min(1).max(500).describe('Text message content to send (up to 500 characters).'),
      conversationId: z.string().optional().describe('Target conversation ID. When omitted, automatically resolves active lobby or champion select chat.')
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    },
    async ({ message, conversationId }) => {
      try {
        const result = await sendChatMessage(ctx, { message, conversationId });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Chat dispatch failed: ${err.message}` }]
        };
      }
    }
  );

  server.tool(
    'lol_chat_status',
    'Update local summoner chat presence status message and availability.',
    {
      availability: z.enum(['chat', 'away', 'dnd', 'mobile']).optional().describe('Availability status ("chat", "away", "dnd", "mobile").'),
      statusMessage: z.string().max(100).optional().describe('Custom status text message displayed to friends (up to 100 characters).')
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true
    },
    async ({ availability, statusMessage }) => {
      try {
        const result = await setChatStatus(ctx, { availability, statusMessage });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Chat status update failed: ${err.message}` }]
        };
      }
    }
  );
}
