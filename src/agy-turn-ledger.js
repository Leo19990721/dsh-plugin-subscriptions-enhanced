import { z } from 'zod';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { isLocalAgyPath } from './agy-launch.js';
import { isAgySessionId } from './agy-session.js';

const stopReason = z.enum(['end_turn', 'cancelled', 'max_tokens', 'max_turn_requests', 'refusal']);
const nonnegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bindingSchema = z.strictObject({
  createdAt: nonnegative,
  cwd: z.string().max(32767).refine(isLocalAgyPath),
  officialId: z.string().refine(isAgySessionId),
  throughSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).refine(value => !Object.is(value, -0)),
  pending: z.strictObject({ turn: nonnegative.min(1) }).readonly().nullable(),
  stopReason: stopReason.optional(),
}).refine(row => (row.throughSeq === -1) === (row.stopReason === undefined)).readonly();

// Authoritative records: an invalid row must stop open, never look like an
// empty binding that can be recreated. Store no conversation or config here.
export const agyTurnLedgerSpec = defineDomain({
  name: 'subscriptions_agy_turns', version: 1, layout: 'per-record',
  tables: { bindings: { valueSchema: bindingSchema } },
});

export async function openAgyTurnLedger(storageDomain) {
  const domain = await storageDomain.open(agyTurnLedgerSpec);
  const rows = domain.table('bindings');
  return Object.freeze({
    read: id => rows.get(id),
    async write(id, row) {
      // Installed storage-domain validates on open, but its put accepts the
      // value verbatim. Validate and detach before handing it to the backend.
      await rows.put(id, bindingSchema.parse(row));
    },
    close: () => domain.close(),
  });
}
