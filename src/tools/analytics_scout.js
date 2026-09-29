import { getChampSelectScout } from '../analytics/scout.js';
import { guard, ok } from './result.js';

export function registerScoutAnalyticsTools(server, ctx) {
  server.registerTool(
    'lol_analytics_champ_select_scout',
    {
      title: 'Scout champion select composition and damage mix',
      description:
        'Scouts active allied team draft in champion select, evaluating physical vs magic damage distribution and detecting composition gaps (e.g. missing frontline, full AD/AP vulnerability). ' +
        'Use this tool during champion select draft to advise on optimal pick choices or role balance before locking in. ' +
        'For locking in, hovering, or banning champions, use lol_workflow_champ_select instead. For setting runes or summoner spells, use lol_workflow_runes_set or lol_workflow_spells_set. ' +
        'Behavior: Safe and read-only; returns cleanly with inChampSelect: false if champion select is inactive. Returns allied draft breakdown and composition warnings.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guard(async () => {
      const result = await getChampSelectScout(ctx.lcu, ctx.staticData);
      return ok(result);
    }, ctx)
  );
}
