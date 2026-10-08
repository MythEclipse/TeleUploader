process.env.BOT_TOKENS = '1:test';
process.env.STORAGE_CHANNEL_ID = '-1001234';
process.env.BASE_URL = 'http://127.0.0.1:4311';
process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:6432/nodb';
process.env.PORT = '4311';

const { RPCHandler } = await import('@orpc/server/fetch');
const { implement, os } = await import('@orpc/server');
const { z } = await import('zod');

const MARK = 'REAL';
const contract = {
  bucket: {
    listBuckets: os.input(z.object({ p: z.string().optional() })).handler(() => ({ ok: 'PLACEHOLDER' })),
    createBucket: os.input(z.object({ name: z.string() })).handler(() => ({ ok: 'PLACEHOLDER' })),
  },
};

const base = implement(contract).$context<{ baseUrl: string }>();
const ctx = { baseUrl: 'http://127.0.0.1:4311' };

const probe = async (label: string, router: any) => {
  const h = new RPCHandler(router);
  for (const [proc, body] of [['/bucket/listBuckets', { json: {} }], ['/bucket/createBucket', { json: { name: 'x' } }]] as const) {
    const res = await h.handle(new Request(`http://127.0.0.1:4311${proc}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { context: ctx } as any);
    const t = res.response ? await res.response.text() : '(none)';
    console.log(`  [${label}] ${proc.padEnd(24)} bound=${t.includes(MARK) ? 'REAL ' : 'PLACEHOLDER'}  ${t.slice(0,80)}`);
  }
};

// SHAPE A (current): nested .router() output
const innerA = base.bucket.router({
  listBuckets: base.bucket.listBuckets.handler(async () => ({ ok: MARK })),
  createBucket: base.bucket.createBucket.handler(async () => ({ ok: MARK })),
});
await probe('A nested .router()', base.router({ bucket: innerA }));

// SHAPE B: raw implementations (no .router() on the inner namespace)
await probe('B raw impls      ', base.router({
  bucket: {
    listBuckets: base.bucket.listBuckets.handler(async () => ({ ok: MARK })),
    createBucket: base.bucket.createBucket.handler(async () => ({ ok: MARK })),
  },
}));

// SHAPE C: spread the .router() result's inner implementations (if it exposes them)
console.log('  typeof innerA =', typeof innerA, 'keys=', Object.keys(innerA as any).slice(0,8));
