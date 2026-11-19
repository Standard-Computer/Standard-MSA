// Shared constants for the send lane (SHA-2959). Dependency-free so the
// recipient page's inline read-timer script and the API route can agree
// without either pulling the database in.

/** EmailOutbound.kind for an MSA send. The projection keys off this. */
export const SEND_EMAIL_KIND = "send";

/** EmailOutbound.kind for an update notice. */
export const NOTICE_EMAIL_KIND = "notice";

/** First-party read-timer beacon for the recipient page. Same-origin. */
export const SEND_VIEW_API_PATH = "/api/sends/view";

/** The read-timer flushes accrued whole seconds this often while visible. */
export const SEND_PING_SECONDS = 15;
