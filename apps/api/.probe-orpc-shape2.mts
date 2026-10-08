const { RPCHandler } = await import('@orpc/server/fetch');
const { implement, os } = await import('@orpc/server');
const { z } = await import('zod');

const contract = {
  bucket: {
    listBuckets: os.input(z.object({ p: z.string().optional() })).handler(() => ({ ok: 'PLACEHOLDER' })),
  },
};
const base = implement(contract).$context<{ baseUrl: string }>();
const ctx = { baseUrl: 'http://x' };

// Does the handler even run? Throw from inside.
const router = base.router({
  bucket: {
    listBuckets: base.bucket.listBuckets.handler(async ({ input, context }) => {
      console.log('    >> HANDLER RAN', JSON.stringify({ input, context }));
      throw new Error('HANDLER_RAN_THREW');
    }),
  },
});
const h = new RPCHandler(router);
const res = await h.handle(new Request('http://x/bucket/listBuckets', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: {} }),
}), { context: ctx } as any);
console.log('  status=', res.response?.status, 'body=', (await res.response?.text())?.slice(0, 160));

// Inspect what .router() returns vs what we passed in.
console.log('  --- identity check ---');
const impl = base.bucket.listBuckets.handler(async () => ({ ok: 'REAL' }));
const built = base.router({ bucket: { listBuckets: impl } });
console.log('  built.bucket.listBuckets === impl ?', (built as any).bucket.listBuckets === impl);
console.log('  built keys:', Object.keys(built as any));
const original = base.router({ bucket: contract.bucket as any });
console.log('  original.bucket.listBuckets is contract obj?', (original as any).bucket.listBuckets === (contract.bucket as any));
