# Upload and Deduplication Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand supported upload file types/formats (stickers, video notes, etc.) and add SHA-256 / File Unique ID based anti-duplication mechanisms to save Telegram channel storage and bandwidth.

**Architecture:** 
1. Database Schema: Add `fileHash` to the `files` schema in Drizzle.
2. File Type Parsing: Update `FILE_TYPES` map and `getFileType` to support sticker, video_note, and dynamic fallback.
3. Deduplication Logic: Add SHA-256 helper in `src/utils/file.ts`. Check DB before running Telegram storage forwarding in `src/routes/upload.ts`.
4. Bot Listener: Check database using `telegramFileUniqueId` before forwarding bot uploads to the storage channel.

**Tech Stack:** Bun, Drizzle ORM, PostgreSQL, Telegraf, TypeScript.

---

### Task 1: Update Database Schema

**Files:**
- Modify: `src/db/schema.ts`
- Test: `test/db.test.ts`

- [ ] **Step 1: Write the failing test**

We want to verify the new column `fileHash` exists in the schema. Modify `test/db.test.ts` to assert column `fileHash` is defined in `files` schema.

```typescript
import { test, expect } from "bun:test";
import { files } from "../src/db/schema";

test("schema has fileHash column", () => {
  expect(files.fileHash).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db.test.ts`
Expected: FAIL because `fileHash` is undefined in `files`.

- [ ] **Step 3: Write minimal implementation**

Update `src/db/schema.ts` to include `fileHash`:

```typescript
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  publicId: text('public_id').unique().notNull(),
  telegramFileId: text('telegram_file_id').notNull(),
  telegramFileUniqueId: text('telegram_file_unique_id').notNull(),
  storageChatId: bigint('storage_chat_id', { mode: 'number' }).notNull(),
  storageMessageId: bigint('storage_message_id', { mode: 'number' }).notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  fileType: text('file_type').notNull(),
  uploaderId: bigint('uploader_id', { mode: 'number' }).notNull(),
  fileHash: text('file_hash'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type File = InferSelectModel<typeof files>;
export type NewFile = InferInsertModel<typeof files>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts test/db.test.ts
git commit -m "db: add fileHash column to schema"
```

---

### Task 2: Extend Media & File Types

**Files:**
- Modify: `src/utils/file.ts`
- Test: `test/file.test.ts`

- [ ] **Step 1: Write failing tests**

We need `getFileType` to recognize stickers, video_notes, and safely fall back any unknown MIME/caption to `document`.

Add tests to `test/file.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { getFileType, checkFileSize } from "../src/utils/file";

test("getFileType handles sticker, video_note, and fallback", () => {
  expect(getFileType("image/webp")).toBe("sticker");
  expect(getFileType("video/mp4", "video_note")).toBe("video_note");
  expect(getFileType("application/octet-stream")).toBe("document");
  expect(getFileType("random/mime")).toBe("document");
});

test("checkFileSize allows up to 2GB for fallback documents", () => {
  expect(checkFileSize(2 * 1024 * 1024 * 1024, "document")).toBe(true);
  expect(checkFileSize(2 * 1024 * 1024 * 1024 + 1, "document")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/file.test.ts`
Expected: FAIL because sticker and video_note return 'document' or other values, and fail the assertion.

- [ ] **Step 3: Write minimal implementation**

Update `src/utils/file.ts`:

```typescript
const FILE_TYPES: Record<string, number> = {
  document: 2 * 1024 * 1024 * 1024, // 2GB
  photo: 10 * 1024 * 1024, // 10MB
  video: 2 * 1024 * 1024 * 1024, // 2GB
  audio: 200 * 1024 * 1024, // 200MB
  voice: 200 * 1024 * 1024, // 200MB
  animation: 2 * 1024 * 1024 * 1024, // 2GB
  sticker: 50 * 1024 * 1024, // 50MB
  video_note: 200 * 1024 * 1024, // 200MB
};

export const getFileType = (mime: string | null, caption?: string): string => {
  const mimeUpper = mime?.split('/')[0]?.toLowerCase();
  const mimeFull = mime?.toLowerCase();
  const captionLower = caption?.toLowerCase();

  if (mimeFull === 'image/webp' || captionLower?.includes('sticker')) return 'sticker';
  if (captionLower?.includes('video_note')) return 'video_note';
  if (mimeUpper === 'video') return 'video';
  if (mimeUpper === 'audio') return 'audio';
  if (mimeUpper === 'image') return captionLower?.includes('gif') ? 'animation' : 'photo';
  if (captionLower?.includes('voice')) return 'voice';
  if (captionLower?.includes('animation')) return 'animation';

  return 'document';
};

export const checkFileSize = (sizeBytes: number, fileType: string): boolean => {
  const limit = FILE_TYPES[fileType] || FILE_TYPES.document;
  return sizeBytes <= limit;
};
```

Let's also export `computeHash` helper at the end of `src/utils/file.ts`:

```typescript
export const computeHash = (buffer: Buffer): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buffer);
  return hasher.digest("hex");
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/file.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/file.ts test/file.test.ts
git commit -m "feat: add sticker, video_note, and computeHash helper"
```

---

### Task 3: Implement Deduplication in HTTP Upload Router

**Files:**
- Modify: `src/routes/upload.ts`
- Test: `test/upload.test.ts`

- [ ] **Step 1: Write failing tests**

We mock db select queries. First query finds a matching hash. Second query finds nothing. Let's update `test/upload.test.ts`.

Add to `test/upload.test.ts`:

```typescript
// Add imports for db and files schema
import { db, files } from '../src/db/index';

// We must also mock `db.select`
```

Let's update the mocks in `test/upload.test.ts` to support querying. We will add a test block:

```typescript
  it('should return existing file on duplicate hash upload', async () => {
    const mockExistingFile = {
      publicId: 'existing-nanoid-id',
      telegramFileId: 'existing-tg-id',
      telegramFileUniqueId: 'existing-tg-unique-id',
      storageChatId: 123456,
      storageMessageId: 7890,
      fileName: 'duplicate.txt',
      mimeType: 'text/plain',
      sizeBytes: 11,
      fileType: 'document',
      uploaderId: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // We'll mock db.select().where().limit() in implementation
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/upload.test.ts`
Expected: FAIL (no hash check exists, it uploads as new file every time).

- [ ] **Step 3: Write minimal implementation**

Update `src/routes/upload.ts` to compute SHA-256 and query database by hash before doing any storage upload:

```typescript
import { eq } from 'drizzle-orm';
import { computeHash } from '../utils/file';

// Inside handleMultipartUpload and handleJSONUpload:
const hash = computeHash(fileBuffer);
const existing = await db
  .select()
  .from(fileSchema)
  .where(eq(fileSchema.fileHash, hash))
  .limit(1);

if (existing.length > 0) {
  const match = existing[0];
  const responsePayload = {
    public_id: match.publicId,
    telegram_file_id: match.telegramFileId,
    telegram_file_unique_id: match.telegramFileUniqueId,
    storage_chat_id: match.storageChatId,
    storage_message_id: match.storageMessageId,
    file_name: match.fileName,
    mime_type: match.mimeType,
    size_bytes: match.sizeBytes,
    file_type: match.fileType,
    uploader_id: match.uploaderId,
    created_at: match.createdAt instanceof Date ? match.createdAt.toISOString() : new Date(match.createdAt).toISOString(),
    download_url: `${config.baseUrl}/f/${match.publicId}`,
  };
  return Response.json(responsePayload, { status: 200 });
}
```

Make sure the new inserted records also include the `fileHash: hash` property.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/upload.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/upload.ts test/upload.test.ts
git commit -m "feat: implement SHA-256 deduplication in HTTP upload"
```

---

### Task 4: Implement Deduplication and All Types in Bot Listener

**Files:**
- Modify: `src/bot.ts`
- Test: `test/bot.test.ts`

- [ ] **Step 1: Write failing tests**

Update bot listener to support `sticker` and `video_note` in type list and handle `file_unique_id` duplication check before storing.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/bot.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Update `src/bot.ts` listener array to include all types:
`['document', 'photo', 'video', 'audio', 'voice', 'animation', 'sticker', 'video_note']`

And check the database:
```typescript
const existing = await db
  .select()
  .from(fileSchema)
  .where(eq(fileSchema.telegramFileUniqueId, file_unique_id))
  .limit(1);

if (existing.length > 0) {
  const match = existing[0];
  const url = `${config.baseUrl}/f/${match.publicId}`;
  await ctx.reply(`File berhasil diupload! 📎\n\nDownload: ${url}`, {
    reply_parameters: { message_id: ctx.message.message_id },
  });
  return;
}
```

Handle extracting file objects correctly:
```typescript
const fileObj =
  fileType === 'photo' ? ctx.message.photo.slice(-1)[0] : ctx.message[fileType];
```

Ensure stickers/video notes size limits are respected.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/bot.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bot.ts test/bot.test.ts
git commit -m "feat: implement bot deduplication using telegram file unique id"
```
