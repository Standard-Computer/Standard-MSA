// MSP identity fields: shape, validation, venue composition (SHA-2956).
//
// PURE on purpose — no Prisma, no React, no server-only — following the
// posture of ShadowPSA's src/lib/legal/variables.ts: the wizard's client
// component, the server action and the tests all need the same rules, and
// they must never disagree. Anything that touches the database lives in
// ./identity.ts instead.

export type MspIdentityInput = {
  /** Trading name — what customers call the MSP. */
  name: string;
  /** Legal entity name — the party the contract header names. */
  legalName: string;
  /** Street address used in the parties / signature blocks. */
  address: string;
  /** Owner / CEO — the MSP-side signatory. */
  ownerName: string;
  /** Notification address (liveness alerts etc. — C3 reads this). */
  email: string;
  /**
   * Public contact number, backing {{msp_phone}} (SHA-4708).
   *
   * OPTIONAL, like `address`: an install that skipped onboarding must keep
   * working, and the public /legal intro drops its contact clause rather
   * than printing a blank. No format validation — "+44 20 7946 0958",
   * "(501) 224-0050 x2" and "call the on-call line" are all things an MSP
   * legitimately puts here, and a regex that rejects one of them would be
   * wrong more often than the typo it caught.
   */
  phone: string;
  /** Public website; also where the /legal embed will live. */
  website: string;
  /** Governing-law venue, part 1: state or province. */
  venueState: string;
  /** Governing-law venue, part 2: country. */
  venueCountry: string;
};

export const EMPTY_IDENTITY_INPUT: MspIdentityInput = {
  name: "",
  legalName: "",
  address: "",
  ownerName: "",
  email: "",
  phone: "",
  website: "",
  venueState: "",
  venueCountry: "",
};

/** Staff-facing labels, shared by the wizard, the settings page and the
 *  re-run diff so a field is called the same thing everywhere. */
export const IDENTITY_FIELD_LABELS: Record<keyof MspIdentityInput, string> = {
  name: "MSP name",
  legalName: "MSP legal name",
  address: "MSP address",
  ownerName: "Owner / CEO",
  email: "Notification email",
  phone: "Phone",
  website: "Website",
  venueState: "Venue state/province",
  venueCountry: "Venue country",
};

/**
 * The venue line the contract renders — "Lonoke County, AR" shape, ported
 * from ShadowPSA's sta9063_legal_venue (venue is OUR fact, one line, same
 * for every recipient). Composed from the two collected parts; the parts
 * are what the wizard edits, the composed line is what {venue} fills.
 */
export function composeVenue(venueState: string, venueCountry: string): string {
  const parts = [venueState.trim(), venueCountry.trim()].filter((p) => p !== "");
  return parts.join(", ");
}

/**
 * Things that must never be templated into a jurisdiction clause silently
 * (the issue's "surface bad venue values" requirement). Braces are the
 * ShadowPSA lesson twice over: "{venue}" inside a venue value would recurse
 * a token into the rendered contract, and doubled braces were the exact
 * mistake sta9063 §2 documents. Control characters and newlines would break
 * the one-line venue clause.
 */
export function venueValueProblems(value: string): string[] {
  const problems: string[] = [];
  if (/[{}]/.test(value)) {
    problems.push("must not contain braces — a brace would render into the jurisdiction clause verbatim");
  }
  if (/[\n\r\t]/.test(value)) {
    problems.push("must be a single line");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    problems.push("contains control characters");
  }
  return problems;
}

/** True when the string parses as an absolute http(s) URL with a hostname. */
export function isValidWebsiteUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // "http://x" parses; require a dot or localhost so a bare word is caught.
  return url.hostname === "localhost" || url.hostname.includes(".");
}

/** Pragmatic parse check — the real test is whether mail arrives, which is
 *  SHA-2958's job. One non-space local part, one @, a dotted domain. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export type IdentityFieldErrors = Partial<Record<keyof MspIdentityInput, string>>;

/**
 * Validate a wizard submission. Returns an empty object when saveable.
 *
 * Required: name, legal name (the issue is explicit), notification email
 * (C3's alerting is dead without it), website (Sean named it, and the
 * /legal embed needs somewhere to live), and both venue parts (a contract
 * with a blank jurisdiction clause is the thing this wizard exists to
 * prevent). Address, owner/CEO and phone (SHA-4708) are prompted for but
 * may be left blank — the header preview renders their labeled blank, which
 * is how the gap stays visible (the variables.ts "show the hole" posture),
 * and the public intro elides its contact clause entirely.
 */
export function validateIdentityInput(input: MspIdentityInput): IdentityFieldErrors {
  const errors: IdentityFieldErrors = {};

  if (input.name.trim() === "") errors.name = "MSP name is required.";
  if (input.legalName.trim() === "") errors.legalName = "Legal name is required — it is the party the contract names.";

  if (input.email.trim() === "") {
    errors.email = "Notification email is required — alerts have nowhere to go without it.";
  } else if (!isValidEmail(input.email)) {
    errors.email = "That does not parse as an email address.";
  }

  if (input.website.trim() === "") {
    errors.website = "Website is required.";
  } else if (!isValidWebsiteUrl(input.website)) {
    errors.website = "Enter an absolute http(s) URL, e.g. https://example.com.";
  }

  for (const key of ["venueState", "venueCountry"] as const) {
    const value = input[key];
    if (value.trim() === "") {
      errors[key] =
        key === "venueState"
          ? "Venue state/province is required — the jurisdiction clause names it."
          : "Venue country is required — the jurisdiction clause names it.";
      continue;
    }
    const problems = venueValueProblems(value);
    if (problems.length > 0) {
      errors[key] = `Venue ${key === "venueState" ? "state/province" : "country"} ${problems.join("; ")}.`;
    }
  }

  return errors;
}

/** Trim every field once, at the boundary, so storage and preview agree. */
export function normalizeIdentityInput(input: MspIdentityInput): MspIdentityInput {
  return {
    name: input.name.trim(),
    legalName: input.legalName.trim(),
    address: input.address.trim(),
    ownerName: input.ownerName.trim(),
    email: input.email.trim(),
    phone: input.phone.trim(),
    website: input.website.trim(),
    venueState: input.venueState.trim(),
    venueCountry: input.venueCountry.trim(),
  };
}
