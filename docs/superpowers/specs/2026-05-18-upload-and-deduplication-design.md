# Design: Multi-Format Upload and Anti-Duplication Feature

This document describes the design for supporting all file types, media, documents, music, images, and other assets, alongside a robust anti-duplication feature based on SHA-256 (HTTP upload) and `telegram_file_unique_id` (Telegram bot upload).

## Requirements

1. **Anti-Duplication**:
   - HTTP Uploads: Compute SHA-256 hash of the uploaded file buffer. If a record with the same hash exists, return the existing file's download URL without uploading again.
   - Telegram Bot Uploads: Identify duplicates via `telegram_file_unique_id`. If the same file is forwarded/uploaded to the bot, return the existing download URL without forwarding again.
2. **Support All Formats & Media**:
   - Handle all media categories: `document`, `photo`, `video`, `audio`, `voice`, `animation`, `sticker`, `video_note`.
   - Fall back safely to `document` for any other unknown MIME types or formats.
   - Size limit for fallback/unknown formats must use the document limit (2GB).

## Architecture & Data Flow

### Database Schema Updates

We need to add a `file_hash` column to the `files` schema.

```typescript
// src/db/schema.ts
export const files = pgTable('files', {
  // ... existing fields ...
  telegramFileUniqueId: text('telegram_file_unique_id').unique().notNull(), // Add unique constraint if not present
  fileHash: text('file_hash'), // SHA-256 for HTTP uploads
  // ...
});
```

### HTTP Upload (Deduplication Flow)

1. Receive multipart form or JSON payload.
2. Generate SHA-256 hash from file buffer:
   ```typescript
   import { Bun } from 'bun';
   const hash = Bun.hash.sha256(fileBuffer).toString('hex'); // Or standard crypto
   ```
3. Check database: `select * from files where file_hash = hash`.
4. If record exists:
   - Return existing file details and download URL directly.
5. If record does not exist:
   - Run standard upload flow to Telegram storage.
   - Insert into DB including `fileHash`.

### Telegram Bot Upload (Deduplication Flow)

1. Receive update with message type (`document`, `photo`, `video`, `audio`, `voice`, `animation`, `sticker`, `video_note`).
2. Extract `file_unique_id`.
3. Check database: `select * from files where telegram_file_unique_id = uniqueId`.
4. If record exists:
   - Return existing download URL.
5. If record does not exist:
   - Forward to storage channel.
   - Insert into DB.

## Testing Strategy

- Unit tests for:
  - Hash generation.
  - Media type parsing (`getFileType`).
  - Size validation.
- Integration tests:
  - Uploading duplicate file via HTTP twice -> second upload returns first upload's `public_id`.
  - Bot receives duplicate `file_unique_id` -> returns existing link.
