// Provider registry (SHA-2958). Adding a provider = one adapter file under
// providers/ plus one line here.

import type { EmailProvider } from "./types";
import { smtp2goProvider } from "./providers/smtp2go";
import { sendgridProvider } from "./providers/sendgrid";
import { smtpProvider } from "./providers/smtp";

const providers: EmailProvider[] = [smtp2goProvider, sendgridProvider, smtpProvider];

export function getProvider(slug: string): EmailProvider | undefined {
  return providers.find((p) => p.slug === slug);
}

export function providerSlugs(): string[] {
  return providers.map((p) => p.slug);
}

export function listProviders(): EmailProvider[] {
  return [...providers];
}
