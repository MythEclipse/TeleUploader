process.env.BOT_TOKENS = '1:test';
process.env.STORAGE_CHANNEL_ID = '-1001234';
process.env.BASE_URL = 'http://127.0.0.1:4311';
process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:6432/nodb';
process.env.PORT = '4311';

const { RPCHandler } = await import('@orpc/server/fetch');
const { buildRouter } = await import('/home/code/Project/TeleUploader/apps/api/src/presentation/orpc/routers/index.ts');

// Distinctive markers so we can tell WHICH handler ran: real override or contract placeholder.
const MARK = 'REAL_OVERRIDE_RAN';
const h = new RPCHandler(buildRouter({
  listBuckets: async () => Response.json({ buckets: [{ id: MARK, name: MARK, createdAt: 'x', objectCount: 42 }] }),
  createBucket: async () => Response.json({ id: MARK, name: MARK }),
  deleteBucket: async () => Response.json({ success: MARK }),
  listObjects: async () => Response.json({ objects: [], prefixes: [], marker: MARK }),
  copyObject: async () => Response.json({ sourceKey: MARK, destKey: MARK, destBucket: MARK }),
  deleteObject: async () => Response.json({ success: MARK }),
  downloadObject: async () => Response.json({ key: MARK, size: 1, etag: null, downloadUrl: MARK }),
} as any));

const ctx = { headers: new Headers(), baseUrl: 'http://127.0.0.1:4311' };

for (const [proc, body] of [
  ['/bucket/listBuckets', {}],
  ['/bucket/createBucket', { json: { name: 'x-probe' } }],
  ['/bucket/listObjects', { json: { bucket: 'x-probe', prefix: 'a/' } }],
  ['/bucket/deleteObject', { json: { bucket: 'x-probe', key: 'a/b.txt' } }],
  ['/bucket/downloadObject', { json: { bucket: 'x-probe', key: 'a/b.txt' } }],
  ['/bucket/copyObject', { json: { bucket: 'x-probe', sourceKey: 'a', destKey: 'b' } }],
  ['/bucket/deleteBucket', { json: { bucket: 'x-probe' } }],
] as const) {
  const res = await h.handle(new Request(`http://127.0.0.1:4311${proc}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { context: ctx } as any);
  const text = res.response ? await res.response.text() : '(no response)';
  const bound = text.includes(MARK) ? 'REAL-OVERRIDE' : 'CONTRACT-PLACEHOLDER';
  console.log(`  ${proc.padEnd(28)} status=${res.response?.status}  bound=${bound}  body=${text.slice(0,110)}`);
}
