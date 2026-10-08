const { RPCHandler } = await import('@orpc/server/fetch');
const { implement, os } = await import('@orpc/server');
const { z } = await import('zod');

const contract = {
  bucket: {
    listBuckets: os.input(z.object({ p: z.string().optional() })).handler(() => ({ ok: 'PLACEHOLDER' })),
  },
};
const base = implement(contract).$context<{ baseUrl: string }>();
console.log('  base keys:', Object.keys(base as any));
console.log('  base.bucket keys:', Object.keys((base as any).bucket));
console.log('  typeof base.bucket.listBuckets:', typeof (base as any).bucket.listBuckets);
console.log('  typeof base.bucket.router:', typeof (base as any).bucket.router);
console.log('  base.bucket.listBuckets keys:', Object.keys((base as any).bucket.listBuckets ?? {}));

const impl = (base as any).bucket.listBuckets.handler(async () => { console.log('    >> RAN'); return { ok: 'REAL' }; });
const built = (base as any).bucket.router({ listBuckets: impl });
console.log('  built keys:', Object.keys(built));
console.log('  built.listBuckets === impl ?', built.listBuckets === impl);
const h = new RPCHandler(built);
const res = await h.handle(new Request('http://x/bucket/listBuckets', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({json:{}}) }), { context: { baseUrl: 'http://x' } } as any);
console.log('  status=', res.response?.status, 'body=', (await res.response?.text())?.slice(0,120));
