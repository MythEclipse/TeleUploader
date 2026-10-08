const { RPCHandler } = await import('@orpc/server/fetch');
const { implement, os } = await import('@orpc/server');
const { z } = await import('zod');

const contract = {
  bucket: {
    listBuckets: os.input(z.object({ p: z.string().optional() })).handler(() => ({ ok: 'PLACEHOLDER' })),
  },
};
const base = implement(contract).$context<{ baseUrl: string }>();
const impl = (base as any).bucket.listBuckets.handler(async () => { console.log('    >> RAN'); return { ok: 'REAL' }; });
console.log('  impl keys:', Object.keys(impl), ' proto:', Object.getOwnPropertyNames(Object.getPrototypeOf(impl)));
console.log('  impl.~orpc keys:', Object.keys(impl['~orpc'] ?? {}));

const built = (base as any).router({ bucket: { listBuckets: impl } });
console.log('  built.bucket keys:', Object.keys(built.bucket));
console.log('  built.bucket.listBuckets keys:', Object.keys(built.bucket.listBuckets ?? {}));
console.log('  built.bucket.listBuckets.~orpc keys:', Object.keys(built.bucket.listBuckets?.['~orpc'] ?? {}));
console.log('  ~orpc orig handler is:', built.bucket.listBuckets?.['~orpc']?.originalHandler ? 'present' : 'absent');

// Try using contract.router directly (no implement) — the documented contract-first path
const c2: any = { ...contract };
const viaContract = (base as any).router({
  bucket: (c2.bucket as any).router({ listBuckets: (base as any).bucket.listBuckets.handler(async () => ({ ok: 'REAL2' })) }),
});
console.log('  viaContract.bucket keys:', Object.keys(viaContract.bucket));
