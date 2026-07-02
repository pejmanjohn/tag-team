import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

import type { ResolvedAssignment } from '../config/types.ts';
import { seededChannelBriefs } from '../config/seed.ts';

/**
 * Assignment-scoped channel-brief tool (Stage 4, part c).
 *
 * The factory closes over the ASSIGNED channel — Flue's trusted-closure
 * authorization pattern. The model chooses the `channelId` argument, but the
 * app enforces the policy: a lookup for any channel other than the assigned one
 * is denied with an honest, non-leaking message. This keeps authorization in
 * app code (the closure), not in the model's discretion, so a compromised or
 * confused model cannot read a brief for a channel it was never assigned to.
 */
export function createLookupChannelBriefTool(assignment: ResolvedAssignment) {
  return defineTool({
    name: 'lookup_channel_brief',
    description:
      'Look up the configured brief for the Slack channel bound to this agent session. Only the assigned channel may be looked up.',
    input: v.object({
      channelId: v.string(),
    }),
    output: v.object({
      brief: v.string(),
    }),
    async run({ input }) {
      if (input.channelId !== assignment.channelId) {
        // Honest, non-leaking denial: names the policy, not the assigned
        // channel id or any other channel's data.
        throw new Error('Denied: lookup_channel_brief is restricted to the assigned channel.');
      }
      return {
        brief: seededChannelBriefs[input.channelId] ?? 'No configured channel brief is available.',
      };
    },
  });
}
