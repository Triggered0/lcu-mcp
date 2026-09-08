import { z } from 'zod';
import { LIFECYCLE_KINDS } from '../lcu/recorder.js';
import { guard, ok } from './result.js';

const KINDS = ['event', ...LIFECYCLE_KINDS];

export function registerRecorderTools(server, ctx) {
  server.registerTool(
    'lol_wamp_record_start',
    {
      title: 'Start recording LCU WAMP traffic',
      description:
        'Open a second WAMP socket to the LCU, independent of lol_events_*, and record every ' +
        'frame plus the socket lifecycle (open, close with its code, error, reconnect gap) into ' +
        'one timeline. Defaults to the firehose, which is what lets you tell "the socket died" ' +
        '(every URI goes quiet at once) from "nothing happened" (one URI quiet, others flowing). ' +
        'Passing uris subscribes per URI instead, which reproduces what a page-side plugin sees ' +
        'but cannot distinguish those two cases. Starting while a recording is already running ' +
        'is an error: pass restart to discard the old one.',
      inputSchema: {
        uris: z
          .array(z.string().startsWith('/'))
          .optional()
          .describe('subscribe per URI instead of the firehose, e.g. ["/lol-gameflow/v1/gameflow-phase"]'),
        restart: z.boolean().optional().describe('discard a running recording and start a fresh one')
      }
    },
    guard(async ({ uris = [], restart = false }) => ok(await ctx.recorder.start({ uris, restart })), ctx)
  );

  server.registerTool(
    'lol_wamp_record_dump',
    {
      title: 'Dump the recorded WAMP timeline',
      description:
        'Return the recorded timeline plus per-URI stats. "stats" is cumulative since the ' +
        'recording started and survives buffer eviction, so a URI that fired and was evicted is ' +
        'still distinguishable from one that never fired. A non-zero "dropped" means entries ' +
        'after your cursor were evicted. Lifecycle entries survive a uri filter; only "kinds" ' +
        'can exclude them. Times are epoch milliseconds, comparable with the page clock.',
      inputSchema: {
        uri: z.string().optional().describe('URI prefix filter, applied to event entries only'),
        since: z.number().optional().describe('lower bound on ts, epoch milliseconds'),
        until: z.number().optional().describe('upper bound on ts, epoch milliseconds'),
        kinds: z.array(z.enum(KINDS)).optional().describe('restrict to these entry kinds'),
        limit: z.number().int().min(1).max(2000).optional().describe('max entries, default 100'),
        cursor: z.number().int().min(0).optional().describe('seq cursor from a previous dump')
      }
    },
    guard(
      async ({ uri = null, since = null, until = null, kinds = null, limit = 100, cursor = 0 }) =>
        ok(ctx.recorder.dump({ uri, since, until, kinds, limit, cursor })),
      ctx
    )
  );

  server.registerTool(
    'lol_wamp_record_stop',
    {
      title: 'Stop recording LCU WAMP traffic',
      description: 'Close the recorder socket. The recorded timeline stays readable with lol_wamp_record_dump.',
      inputSchema: {}
    },
    guard(async () => ok(ctx.recorder.stop('tool')), ctx)
  );
}
