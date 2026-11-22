import { createHash } from 'node:crypto';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

const receiptSchema = z.strictObject({
  phase: z.enum(['may-have-sent', 'settled']),
  time: z.number().int().nonnegative(),
});
const spec = defineDomain({ name: 'subscriptions_agy_receipts', version: 1, layout: 'per-record',
  tables: { receipts: { valueSchema: receiptSchema } } });

/** Send receipts contain no prompt, official session ID, path, or account data. */
export async function openAgySubscriptionReceipts(storageDomain) {
  const domain = await storageDomain.open(spec);
  const rows = domain.table('receipts');
  const keyOf = ({ sessionId, createdAt, messageId, requestId }) => createHash('sha256')
    .update(JSON.stringify([sessionId, createdAt, messageId, requestId])).digest('hex');
  return Object.freeze({
    async reserve(identity) {
      const key = keyOf(identity);
      if (rows.get(key) !== undefined) return;
      const reserved = receiptSchema.parse({ phase: 'may-have-sent', time: Date.now() });
      await rows.put(key, reserved);
      const verify = () => {
        const row = rows.get(key);
        return row?.phase === reserved.phase && row.time === reserved.time;
      };
      if (!verify()) throw new Error('Google subscription send receipt could not be verified.');
      return Object.freeze({
        verify,
        async releaseUnsent() {
          if (!verify() || !await rows.delete(key)) throw new Error('Google subscription receipt could not be revoked.');
        },
        async settle() {
          if (!verify()) throw new Error('Google subscription receipt could not be verified.');
          await rows.put(key, receiptSchema.parse({ ...reserved, phase: 'settled' }));
        },
      });
    },
    close: () => domain.close(),
  });
}
