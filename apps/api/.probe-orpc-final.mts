const { implement, os, isProcedure } = await import('@orpc/server');
const { z } = await import('zod');
const contract = { sayHello: os.input(z.object({ name: z.string() })).handler(() => ({ greeting: 'PLACEHOLDER' })) };
const p: any = contract.sayHello;
console.log('  isProcedure(contract.sayHello) =', isProcedure(p), '  <-- true means the matcher uses the CONTRACT as the procedure');
console.log('  ~orpc keys of contract proc:', Object.keys(p['~orpc'] ?? {}));
