const { RPCHandler } = await import('@orpc/server/fetch');
const { implement, os } = await import('@orpc/server');
const { z } = await import('zod');

// FLAT contract — the exact shape from oRPC's docs.
const contract = {
  sayHello: os.input(z.object({ name: z.string() })).handler(() => ({ greeting: 'PLACEHOLDER' })),
};
const base = implement(contract).$context<{ baseUrl: string }>();
const router = base.router({
  sayHello: base.sayHello.handler(async ({ input }) => { console.log('    >> RAN with', JSON.stringify(input)); return { greeting: `REAL ${input.name}` }; }),
});
const h = new RPCHandler(router);
const res = await h.handle(new Request('http://x/sayHello', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({json:{name:'ana'}}) }), { context: { baseUrl: 'http://x' } } as any);
const t = res.response ? await res.response.text() : '(none)';
console.log('  FLAT status=', res.response?.status, 'bound=', t.includes('REAL') ? 'REAL' : 'PLACEHOLDER', t.slice(0,90));
