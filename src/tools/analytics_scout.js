import { getChampSelectScout } from '../analytics/scout.js';

export function registerScoutAnalyticsTools(server, ctx) {
  server.tool(
    'lol_analytics_champ_select_scout',
    'Scout active champion select allied team draft, estimating damage distribution (AP/AD mix) and composition vulnerabilities.',
    {},
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    async () => {
      try {
        const result = await getChampSelectScout(ctx.lcu, ctx.staticData);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Champion select scouting failed: ${err.message}` }]
        };
      }
    }
  );
}
