// Website reachability probe (SHA-2956).
//
// The issue asks that the website "is a reachable URL". Format is a hard
// validation error (fields.ts); reachability is a PROBE whose failure is
// DATA, not an exception (architecture principle 5): a site that happens to
// be down while its owner runs onboarding should produce a visible warning
// the operator can override, not a wall. The server action blocks the save
// until the operator either fixes the URL or explicitly accepts the warning.

export type ReachabilityResult =
  | { ok: true; status: number }
  | { ok: false; reason: string };

/**
 * One GET with a short timeout, redirects followed. GET rather than HEAD:
 * enough real sites answer HEAD with 405/403 that a HEAD-only probe would
 * cry wolf, and we read no body either way. `fetchFn` is injectable so
 * tests never touch the network.
 */
export async function probeWebsite(
  url: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<ReachabilityResult> {
  try {
    const res = await fetchFn(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "Standard-MSA onboarding check" },
    });
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, reason: `responded with HTTP ${res.status}` };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, reason: `did not respond within ${Math.round(timeoutMs / 1000)}s` };
    }
    return { ok: false, reason: "could not be reached (DNS or connection failure)" };
  }
}
