const modules = [
  {
    title: "Onboarding",
    body: "MSP identity, contract header preview, venue. Re-run any time.",
    lane: "SHA-2956",
  },
  {
    title: "/legal site",
    body: "Public legal pages, website embed generator, visitor log, liveness monitor.",
    lane: "SHA-2957",
  },
  {
    title: "Email delivery",
    body: "SMTP2GO / SendGrid / SMTP — configured at runtime, keys from env only.",
    lane: "SHA-2958",
  },
  {
    title: "MSA sends",
    body: "Unique per-recipient MSAs with full lifecycle tracking and acceptance evidence.",
    lane: "SHA-2959",
  },
  {
    title: "API",
    body: "API surface for PSA/AI tools to create MSA sends.",
    lane: "SHA-2960",
  },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Standard-MSA</h1>
      <p className="mt-2 text-slate-600">
        Stand-alone, self-hosted MSA/compliance tool for MSPs. Scaffold build —
        modules land here as they are completed.
      </p>
      <ul className="mt-8 space-y-4">
        {modules.map((m) => (
          <li key={m.title} className="rounded-lg border border-slate-200 p-4">
            <div className="font-medium">{m.title}</div>
            <div className="text-sm text-slate-600">{m.body}</div>
          </li>
        ))}
      </ul>
    </main>
  );
}
