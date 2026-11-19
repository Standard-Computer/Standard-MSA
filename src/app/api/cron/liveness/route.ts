import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { legalSettings } from "@/lib/legal/settings";
import { getAlertSender } from "@/lib/liveness/delivery";
import { runLivenessTick, type MonitorSnapshot } from "@/lib/liveness/liveness";
import { purgeCutoff } from "@/lib/visits/visits";

// The liveness cron tick (SHA-2957). Architecture § Operations: scheduled
// work is `GET /api/cron/*` guarded by CRON_SECRET — the operator points
// their own cron/systemd timer/Docker sidecar at it (README § Liveness
// monitor documents the one-liner). Each tick also runs the visitor-log
// retention purge, so an install with the monitor off still honours its
// configured retention as long as any cron is wired.
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  // ?secret= is accepted for crontab-friendliness; the README warns that a
  // URL-borne secret lands in proxy logs and recommends the header form.
  return req.nextUrl.searchParams.get("secret") === secret;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const settings = await legalSettings();

  // Retention purge first: it must run whether or not the monitor is on.
  const cutoff = purgeCutoff(settings.visitRetentionDays, new Date());
  const purged = await prisma.legalVisit.deleteMany({
    where: { occurredAt: { lt: cutoff } },
  });

  if (!settings.monitorEnabled || !settings.monitorUrl) {
    return Response.json({ monitor: "disabled", purgedVisits: purged.count });
  }

  const prevRow = await prisma.monitorState.findFirst({ orderBy: { id: "asc" } });
  const prev: MonitorSnapshot = {
    status: prevRow?.status ?? "unknown",
    consecutiveFailures: prevRow?.consecutiveFailures ?? 0,
    downSince: prevRow?.downSince ?? null,
    lastAlertAt: prevRow?.lastAlertAt ?? null,
    lastRecoveryAt: prevRow?.lastRecoveryAt ?? null,
  };

  const identity = await prisma.mspIdentity.findFirst({ orderBy: { id: "asc" } });
  const run = await runLivenessTick(settings.monitorUrl, req.nextUrl.origin, prev, {
    fetchImpl: fetch,
    sender: await getAlertSender(),
    alertTo: identity?.email ?? null,
    now: () => new Date(),
  });

  const now = new Date();
  const stateData = {
    status: run.state.status,
    consecutiveFailures: run.state.consecutiveFailures,
    downSince: run.state.downSince,
    lastAlertAt: run.state.lastAlertAt,
    lastRecoveryAt: run.state.lastRecoveryAt,
    lastCheckedAt: now,
    lastDetail: run.probe.detail.slice(0, 500),
  };
  if (prevRow) {
    await prisma.monitorState.update({ where: { id: prevRow.id }, data: stateData });
  } else {
    await prisma.monitorState.create({ data: stateData });
  }

  await prisma.siteCheck.create({
    data: {
      targetUrl: settings.monitorUrl,
      ok: run.probe.ok,
      statusCode: run.probe.statusCode,
      detail:
        run.action === null
          ? run.probe.detail.slice(0, 500)
          : `${run.probe.detail.slice(0, 400)} [${run.action}${run.emailed ? ", emailed" : run.emailError ? `, ${run.emailError}` : ""}]`,
      alerted: run.action !== null && run.emailed,
    },
  });

  return Response.json({
    monitor: run.state.status,
    detail: run.probe.detail,
    action: run.action,
    emailed: run.emailed,
    emailError: run.emailError,
    purgedVisits: purged.count,
  });
}
