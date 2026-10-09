/**
 * S3 controller facade.
 *
 * Per-operation handlers live in `./s3/` (s3-common, s3-router,
 * s3-bucket-handlers, s3-object-read, s3-object-write, s3-listing,
 * s3-multipart-handlers). This module re-exports the dispatcher.
 *
 * The old `routes/index.ts` route table this facade once kept "working
 * unchanged" for is DELETED (P4 deadcode). `app.ts` imports `handleS3Request`
 * from here directly; nothing imports the table.
 */
export { handleS3Request } from "./s3/s3-router";
