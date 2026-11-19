-- Add-only: record the cause of an internal_error response on the per-key
-- request log row. Nullable TEXT column; no rebuild, no data movement.
ALTER TABLE "ApiRequestLog" ADD COLUMN "error" TEXT;
