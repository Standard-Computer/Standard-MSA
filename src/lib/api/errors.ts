// Typed API errors (SHA-2960). PURE.
//
// Every error the public API returns has the same body shape and a STABLE
// machine code — the ergonomics requirement for AI callers, who branch on
// `error.code`, not on prose. The message is for humans and may change;
// the code never does without a changelog entry in docs/API.md.

import type { ZodError } from "zod";

export const API_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "validation_failed",
  "conflict",
  "idempotency_key_reused",
  "rate_limited",
  "email_not_configured",
  "internal_error",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const DEFAULT_STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  idempotency_key_reused: 409,
  rate_limited: 429,
  email_not_configured: 409,
  internal_error: 500,
};

export type ApiErrorDetail = { path: string; message: string };

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: ApiErrorDetail[];
  readonly headers: Record<string, string>;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { status?: number; details?: ApiErrorDetail[]; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.details = options.details ?? [];
    this.headers = options.headers ?? {};
  }

  body(): { error: { code: ApiErrorCode; message: string; details?: ApiErrorDetail[] } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details.length > 0 ? { details: this.details } : {}),
      },
    };
  }
}

/** A zod failure as a validation_failed ApiError with per-field details. */
export function validationError(error: ZodError): ApiError {
  const details: ApiErrorDetail[] = error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(body)",
    message: issue.message,
  }));
  return new ApiError("validation_failed", "The request body failed validation.", { details });
}
