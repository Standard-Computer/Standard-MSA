// The monitor's delivery seam (SHA-2957).
//
// This lane CONSUMES email delivery, it never wires a provider: SHA-2958
// owns `src/lib/email/**` and its `sendEmail()` is the only way any lane
// sends mail (docs/ARCHITECTURE.md § Module boundaries). Until that lane
// lands on main, `getAlertSender()` resolves to null and the monitor records
// the alert in the database instead — the operator screen shows "email not
// configured" rather than anything silently pretending to send.
//
// The message shape deliberately mirrors SHA-2958's `EmailMessage`
// (to/subject/text/html/kind), so wiring is one line in this file when it
// lands and no caller changes:
//
//   const { sendEmail } = await import("@/lib/email/send");
//   return { send: (m) => sendEmail(m) };
//
// No provider, no key, and no env read happens here.

export type AlertMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Caller tag for the delivery log, e.g. "liveness-alert". */
  kind?: string;
};

export type AlertSendResult = { ok: boolean; error?: string };

export interface AlertSender {
  send(msg: AlertMessage): Promise<AlertSendResult>;
}

/** Null until SHA-2958's email lane lands; see the header. */
export async function getAlertSender(): Promise<AlertSender | null> {
  return null;
}
