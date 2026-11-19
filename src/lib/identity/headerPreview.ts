// Contract-header preview (SHA-2956), rendered live in the wizard and again
// on the settings page from saved values.
//
// Ported semantics, not ported code, from ShadowPSA's src/lib/legal/
// variables.ts — the full merge engine (19-key vocabulary, render modes,
// gap repair) is SHA-2957's lane. What this file keeps faithful to it:
//
//   • A missing MSP value renders its LABELED BLANK ("[MSP legal name]"),
//     never an empty string — a header that reads "between  and the
//     Customer" hides the gap; the blank shows it (variables.ts, "filled"
//     fallback rationale).
//   • Customer-side values render NEUTRAL GENERIC PROSE, verbatim from THIS
//     repo's renderer — GENERIC_PUBLIC in src/lib/legal/variables.ts ("the
//     Client", "the Client's address of record") — because the preview's
//     promise is "exactly what a generated document will say", and documents
//     here render through that engine, not ShadowPSA's. (Follow-up SHA-3012
//     review: export GENERIC_PUBLIC and derive these so they cannot drift.)
//   • The effective date reads "the date of acceptance" — both of the
//     engine's date variables resolve per-send, at acceptance, and on a
//     surface with no send neither has happened (Sean's "ANY date field"
//     ruling; GENERIC_PUBLIC's effective_date entry).
//   • A d/b/a that adds nothing VANISHES rather than announcing itself —
//     the trading name is shown only when it differs from the legal name
//     (client_dba's empty-string posture).
//
// PURE on purpose: the wizard renders this client-side on every keystroke,
// the confirm step and the settings page render it server-side, and the
// tests assert both against the same function.

import { composeVenue } from "./fields";

/** The subset of MspIdentity the header reads. All strings may be empty. */
export type HeaderValues = {
  name: string;
  legalName: string;
  address: string;
  ownerName: string;
  venueState: string;
  venueCountry: string;
};

/** Labeled blanks, in the ShadowPSA "[...]" convention. */
const BLANKS = {
  legalName: "[MSP legal name]",
  address: "[MSP address]",
  ownerName: "[Owner / CEO]",
  venue: "[Venue]",
} as const;

/** Customer-side generic prose — verbatim from GENERIC_PUBLIC in
 *  src/lib/legal/variables.ts (client_legal_name, client_address,
 *  signer_name, effective_date), which is what a generated document
 *  actually renders when these values are unresolved. */
export const CUSTOMER_GENERIC = {
  legalName: "the Client",
  address: "the Client's address of record",
  signerName: "the Client's authorized signatory",
  date: "the date of acceptance",
} as const;

export type ContractHeaderPreview = {
  /** "This Master Services Agreement … between X … and the Client …" */
  partiesBlock: string;
  /** "Governing law and venue: … the courts of Lonoke County, AR, USA." */
  venueLine: string;
  /** "Effective date: the date of acceptance" — resolves per-send, never here. */
  effectiveDateLine: string;
  /** "Signed for the Provider by …" */
  signatureLine: string;
  /** Labels of the MSP values still missing — what the blanks stand for. */
  missing: string[];
};

function value(raw: string, blank: string, missing: string[], label: string): string {
  const v = raw.trim();
  if (v !== "") return v;
  missing.push(label);
  return blank;
}

/**
 * Render the three header pieces the wizard previews. Deterministic and
 * total: bad input never throws, it renders blanks and reports them in
 * `missing` so the UI can list what the MSP still owes the contract.
 */
export function renderContractHeader(values: HeaderValues): ContractHeaderPreview {
  const missing: string[] = [];

  const legalName = value(values.legalName, BLANKS.legalName, missing, "MSP legal name");
  const address = value(values.address, BLANKS.address, missing, "MSP address");
  const ownerName = value(values.ownerName, BLANKS.ownerName, missing, "Owner / CEO");

  // d/b/a: only when the trading name adds information. A blank trading
  // name, or one equal to the legal name, vanishes — never "d/b/a []".
  const name = values.name.trim();
  const dba = name !== "" && name.toLowerCase() !== legalName.toLowerCase() ? `, d/b/a ${name}` : "";

  const partiesBlock =
    `This Master Services Agreement ("Agreement") is entered into between ` +
    `${legalName}${dba}, of ${address} ("Provider"), and ` +
    `${CUSTOMER_GENERIC.legalName}, of ${CUSTOMER_GENERIC.address} ("Customer").`;

  const composedVenue = composeVenue(values.venueState, values.venueCountry);
  const venue = composedVenue !== "" ? composedVenue : BLANKS.venue;
  if (composedVenue === "") missing.push("Venue");
  const venueLine =
    `Governing law and venue: this Agreement is governed by the laws of ${venue}, ` +
    `and the parties submit to the exclusive jurisdiction of the courts of ${venue}.`;

  const effectiveDateLine = `Effective date: ${CUSTOMER_GENERIC.date}.`;

  const signatureLine =
    `Signed for the Provider by ${ownerName}, and for the Customer by ` +
    `${CUSTOMER_GENERIC.signerName}.`;

  return { partiesBlock, venueLine, effectiveDateLine, signatureLine, missing };
}
