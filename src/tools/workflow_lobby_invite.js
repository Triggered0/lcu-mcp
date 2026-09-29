import { z } from 'zod';
import { inviteToLobby } from '../workflow/lobby_invite.js';

export function registerWorkflowLobbyInviteTool(server, ctx) {
  server.tool(
    'lol_workflow_lobby_invite',
    'Invite friends or teammates to the active game lobby by summoner PUUID.',
    {
      toSummonerPuuids: z.array(z.string()).min(1).describe('Array of summoner PUUIDs to invite to the lobby.')
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    },
    async ({ toSummonerPuuids }) => {
      try {
        const result = await inviteToLobby(ctx, { toSummonerPuuids });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Lobby invite failed: ${err.message}` }]
        };
      }
    }
  );
}
