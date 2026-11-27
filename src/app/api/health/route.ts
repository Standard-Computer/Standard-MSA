// Liveness probe (SHA-4455).
//
// Exists because a platform healthcheck needs ONE path that answers 200 in
// every legitimate state of this app, and no screen does: `/` and `/login`
// both redirect on an instance that has not been claimed yet, and a 3xx is
// not a healthy answer to a probe that does not follow redirects.
//
// It is deliberately the least informative endpoint in the app. No version,
// no commit, no migration state, no "has this instance been claimed" — all of
// which would be free reconnaissance on a public URL, and none of which a
// liveness probe needs. "This process is serving HTTP" is the whole claim.
//
// Readiness is a separate thing and is NOT measured here: the container does
// not start serving until docker-entrypoint.sh has applied migrations, so by
// the time this answers at all, the database is migrated.

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Robots-Tag": "noindex",
    },
  });
}
