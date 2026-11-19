// Shared by the frame script (a template literal) and the visit API. Kept
// dependency-free so embedDocument.ts can import it without pulling the db.

/** First-party beacon endpoint the frame posts to. Same-origin by design. */
export const VISIT_API_PATH = "/api/legal/visit";

/** The read-timer flushes accrued whole seconds this often while visible. */
export const VISIT_PING_SECONDS = 15;

/**
 * Server-side clamp per ping. The client is untrusted: a lying client can at
 * worst inflate time-on-page by one interval per call, same posture as
 * ShadowPSA's DOCUMENT_READ_MAX_PING_SECONDS.
 */
export const VISIT_MAX_PING_SECONDS = 120;

/** Hard cap on total accrued seconds per visit row (24h). */
export const VISIT_MAX_TOTAL_SECONDS = 86_400;
