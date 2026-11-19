// The /api/v1 request pipeline (SHA-2960).
//
// Every public API route is `apiHandler(...)` around a plain function, so
// auth, scopes, rate limiting, idempotency, request logging and the error
// envelope are decided ONCE. A route file contributes only its own logic
// and its zod schemas; if a route ever needs to differ on one of these
// policies, that difference belongs here, visibly, not re-implemented in
// the route.

import type { ApiKey } from "@prisma/client";
import { ZodError } from "zod";
import { prisma } from "@/lib/db";
import { redactSecrets } from "@/lib/email/redact";
import { clientIpFrom } from "@/lib/visits/visits";
import { ApiError, validationError } from "./errors";
import { authenticateApiKey, keyHasScope, type ApiScope } from "./keys";
import { idempotencyKeyFrom, withIdempotency } from "./idempotency";
import { checkRateLimit, rateLimitHeaders } from "./ratelimit";

export type ApiResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export type ApiContext = {
  req: Request;
  apiKey: ApiKey;
  /** Resolved route params (Next hands them over as a promise). */
  params: Record<string, string>;
  /** Parsed JSON body; undefined when the request has none. */
  json: unknown;
};

export type ApiHandlerOptions = {
  /** Scope this endpoint requires of the key. */
  scope: ApiScope;
  /** Stable endpoint label for the request log and idempotency store,
   *  e.g. "POST /sends". */
  endpoint: string;
  /** Honour Idempotency-Key (POST creates only). */
  idempotent?: boolean;
};

type RouteContext = { params?: Promise<Record<string, string>> };
export type RouteHandler = (req: Request, ctx?: RouteContext) => Promise<Response>;

function jsonResponse(result: ApiResult, extraHeaders: Record<string, string>): Response {
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store", ...extraHeaders, ...(result.headers ?? {}) },
  });
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError("validation_failed", "The request body is not valid JSON.");
  }
}

export function apiHandler(
  options: ApiHandlerOptions,
  handler: (ctx: ApiContext) => Promise<ApiResult>,
): RouteHandler {
  return async (req: Request, routeCtx?: RouteContext): Promise<Response> => {
    const startedAt = Date.now();

    const apiKey = await authenticateApiKey(req.headers.get("authorization"));
    if (!apiKey) {
      // Not logged: there is no key row to attribute the request to, and a
      // log an unauthenticated caller can fill is a disk-exhaustion lever.
      const err = new ApiError("unauthorized", "Provide a valid API key as `Authorization: Bearer smsa_…`.");
      return jsonResponse({ status: err.status, body: err.body() }, {});
    }

    const limit = checkRateLimit(apiKey.id);
    const limitHeaders = rateLimitHeaders(limit);
    let result: ApiResult;
    let failureCause: string | null = null;
    try {
      if (!limit.allowed) {
        throw new ApiError("rate_limited", "Rate limit exceeded for this API key.", {
          headers: limitHeaders,
        });
      }
      if (!keyHasScope(apiKey, options.scope)) {
        throw new ApiError("forbidden", `This API key does not have the ${options.scope} scope.`);
      }

      const params = routeCtx?.params ? await routeCtx.params : {};
      const json = req.method === "GET" || req.method === "HEAD" ? undefined : await readJson(req);
      const ctx: ApiContext = { req, apiKey, params, json };

      if (options.idempotent) {
        const stored = await withIdempotency(
          apiKey.id,
          options.endpoint,
          idempotencyKeyFrom(req.headers),
          json,
          async () => {
            const r = await handler(ctx);
            return { status: r.status, body: r.body };
          },
        );
        result = {
          status: stored.status,
          body: stored.body,
          headers: stored.replayed ? { "Idempotency-Replayed": "true" } : {},
        };
      } else {
        result = await handler(ctx);
      }
    } catch (err) {
      const apiErr =
        err instanceof ApiError
          ? err
          : err instanceof ZodError
            ? validationError(err)
            : new ApiError("internal_error", "Something went wrong handling this request.");
      if (apiErr.code === "internal_error") {
        // The caller gets the envelope; the operator's request log gets the
        // cause (the `error` column below). Nothing goes to stdout/stderr.
        // Redacted first: a provider error can quote a key or an accept-token
        // URL back at us, and this column is durable.
        failureCause = redactSecrets(
          err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        );
      }
      result = { status: apiErr.status, body: apiErr.body(), headers: apiErr.headers };
    }

    // Best-effort bookkeeping: a logging failure must never turn a handled
    // request into a 500 after the fact.
    try {
      await prisma.apiRequestLog.create({
        data: {
          apiKeyId: apiKey.id,
          method: req.method,
          path: new URL(req.url).pathname.slice(0, 300),
          status: result.status,
          ip: clientIpFrom((name) => req.headers.get(name)),
          durationMs: Date.now() - startedAt,
          error: failureCause ? failureCause.slice(0, 500) : null,
        },
      });
      await prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } });
    } catch (logErr) {
      // If the log write itself fails there is no durable channel left to
      // record that in, and the caller's already-handled response must not
      // become a 500 over bookkeeping. stderr is the one channel that cannot
      // itself fail into this catch, so the failure is at least diagnosable
      // from the container log (reviewer round-2, finding 3).
      process.stderr.write(
        `[api] request-log write failed: ${redactSecrets(
          logErr instanceof Error ? `${logErr.name}: ${logErr.message}` : String(logErr),
        )}\n`,
      );
    }

    return jsonResponse(result, limitHeaders);
  };
}
