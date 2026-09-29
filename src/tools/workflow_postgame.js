import { z } from 'zod';
import { triggerPlayAgain, submitHonor } from '../workflow/postgame.js';
import { guard, ok } from './result.js';

export function registerWorkflowPostgameTools(server, ctx) {
  server.registerTool(
    'lol_workflow_play_again',
    {
      title: 'Recreate game lobby from post-game screen',
      description:
        'Triggers lobby recreation with the previous game queue and party settings from the End of Game or post-match screen. ' +
        'Use this tool after a match completes to quickly return to a queue lobby without manually reselecting game modes. ' +
        'For creating a brand-new lobby with a specific queue ID, use lol_workflow_lobby instead. For honoring teammates, use lol_workflow_honor. ' +
        'Behavior: Mutates client gameflow state; requires client to be in EndOfGame or PreEndOfGame phase. ' +
        'Needs "POST /lol-lobby/v2/play-again" on the write allowlist.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    guard(async () => {
      const result = await triggerPlayAgain(ctx);
      return ok(result);
    }, ctx)
  );

  server.registerTool(
    'lol_workflow_honor',
    {
      title: 'Submit teammate honor vote',
      description:
        'Submits a post-game honor vote for an eligible allied teammate by summoner name, gameName, or summonerId with a selected honor category ("COOL", "SHOTCALLER", or "HEART"). ' +
        'Use this tool when voting on the post-match honor ballot before returning to the lobby. ' +
        'For recreating the previous game lobby, use lol_workflow_play_again. For inspecting post-game match statistics, use lol_analytics_match_detail. ' +
        'Behavior: Submits an irreversible honor vote; fails cleanly if no honor ballot is active or target is not found on ballot. ' +
        'Needs "POST /lol-honor/v1/honor" on the write allowlist.',
      inputSchema: {
        target: z.union([z.string(), z.number()]).describe('Target teammate summoner name, gameName, or summonerId.'),
        honorCategory: z.enum(['COOL', 'SHOTCALLER', 'HEART']).default('HEART').describe('Honor badge category ("COOL", "SHOTCALLER", or "HEART", default "HEART").')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    guard(async ({ target, honorCategory }) => {
      const result = await submitHonor(ctx, { target, honorCategory });
      return ok(result);
    }, ctx)
  );
}
