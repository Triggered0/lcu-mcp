import { z } from 'zod';
import { inviteToLobby } from '../workflow/lobby_invite.js';
import { guard, ok } from './result.js';

export function registerWorkflowLobbyInviteTool(server, ctx) {
  server.registerTool(
    'lol_workflow_lobby_invite',
    {
      title: 'Invite summoners to active party lobby',
      description:
        'Dispatches invitations to one or more summoner PUUIDs to join the current game lobby party. ' +
        'Use this tool after creating a lobby when inviting friends or premade party members. ' +
        'For creating a lobby or starting matchmaking search, use lol_workflow_lobby instead. For accepting match ready checks, use lol_workflow_matchmaking_accept. ' +
        'Behavior: Mutates lobby invitation state; fails with diagnostic error if not currently in a lobby. ' +
        'Needs "POST /lol-lobby/v2/lobby/invitations" on the write allowlist.',
      inputSchema: {
        toSummonerPuuids: z.array(z.string()).min(1).describe('Array of summoner PUUID strings to invite to the lobby.')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    guard(async ({ toSummonerPuuids }) => {
      const result = await inviteToLobby(ctx, { toSummonerPuuids });
      return ok(result);
    }, ctx)
  );
}
