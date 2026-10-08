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
console.log('  impl own keys:', Object.keys(impl));
console.log('  impl proto keys:', Object.getOwnPropertyNames(Object.getPrototypeOf(impl)));
for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(impl))) {
  const v = (impl as any)[k];
  console.log(`    proto.${k} =`, typeof v === 'function' ? 'fn' : typeof v);
}
