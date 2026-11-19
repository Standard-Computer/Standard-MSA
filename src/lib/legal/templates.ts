// Starter document templates (SHA-3086). PURE.
//
// A fresh self-hosted install has ZERO documents — nothing to publish,
// nothing to send. These templates are the starting matter: the operator
// imports one as their own DRAFT, edits it, and nothing is visible anywhere
// until they publish. Sean's SHA-2970 ruling put both the MSA and the HIPAA
// BAA in v1, so both ship here.
//
// These are EXAMPLES, not legal advice. This repo is public and other MSPs
// will self-host it, so the disclaimer below is surfaced everywhere a
// template appears (the /documents banner, the import flow, the README and
// docs/SELF-HOSTING.md) — an operator must have their own counsel review
// anything they publish.
//
// Bodies use the same {{variable}} syntax src/lib/legal/variables.ts
// renders: MSP tokens fill from MspIdentity, client/signer tokens render as
// neutral prose on the public surface and as real values on a send, and the
// per-template `variables` below become the draft's editable defaults. No
// price, rate or amount is hard-coded in code — the few numeric terms are
// template DEFAULTS the operator edits, stored on their draft.

export type StarterTemplate = {
  /** Suggested slug; the operator can change it at import. */
  slug: string;
  kind: string;
  title: string;
  /** Draft defaults for tokens that are neither MSP- nor client-sourced. */
  variables: Record<string, string>;
  bodyMarkdown: string;
};

export const TEMPLATE_DISCLAIMER =
  "Starter templates are examples to edit, not legal advice. Have your own counsel " +
  "review any document before you publish or send it.";

const MSA_BODY = `## Master Service Agreement

This Master Service Agreement (the "Agreement") is made between **{{msp_legal_name}}** of {{msp_address}} (the "Provider") and **{{client_legal_name}}** of {{client_address}} (the "Client"), effective as of {{effective_date}}.

### 1. Services

1.1 The Provider will deliver the managed IT services described in one or more quotes, proposals or order forms agreed in writing between the parties (each an "Order"). Each Order is governed by this Agreement.

1.2 The Provider may update tooling, processes and personnel used to deliver the services, provided the services themselves continue to meet the applicable Order.

### 2. Term and Termination

2.1 This Agreement starts on the effective date above and continues until terminated under this section. Each Order states its own initial term and renewal.

2.2 Either party may terminate this Agreement or any Order with {{notice_period_days}} days' written notice, or immediately if the other party materially breaches this Agreement and fails to cure within {{cure_period_days}} days of written notice of the breach.

2.3 On termination, the Provider will reasonably cooperate in an orderly handover. Work performed through the effective date of termination remains chargeable.

### 3. Fees and Payment

3.1 Fees are as stated in the applicable Order. Unless an Order says otherwise, recurring fees are invoiced in advance and time-and-materials work is invoiced in arrears.

3.2 Invoices are due within {{payment_terms_days}} days of the invoice date. The Provider may suspend services on accounts that remain unpaid after written notice.

3.3 Fees exclude applicable taxes, which the Client pays except for taxes on the Provider's income.

### 4. Client Responsibilities

4.1 The Client will provide timely access to systems, premises and personnel reasonably needed to deliver the services, and will keep its own software licensing current.

4.2 The Client is responsible for the accuracy of information it supplies and for decisions it makes based on the Provider's recommendations.

### 5. Confidentiality

5.1 Each party will protect the other's non-public information with at least the care it uses for its own, and use it only to perform under this Agreement.

5.2 This obligation survives termination and does not apply to information that is public through no fault of the receiving party, independently developed, or required to be disclosed by law.

### 6. Data Protection and Security

6.1 The Provider will maintain commercially reasonable administrative, technical and physical safeguards for Client data in its care.

6.2 Where the parties have executed a Business Associate Agreement or other data-protection addendum, that addendum controls for the data it covers.

### 7. Warranties and Disclaimer

7.1 The Provider warrants that services will be performed in a professional and workmanlike manner. The Client's remedy for breach of this warranty is re-performance of the affected services.

7.2 EXCEPT AS STATED IN THIS AGREEMENT, THE SERVICES ARE PROVIDED WITHOUT ANY OTHER WARRANTY, EXPRESS OR IMPLIED, INCLUDING FITNESS FOR A PARTICULAR PURPOSE.

### 8. Limitation of Liability

8.1 Neither party is liable for indirect, incidental or consequential damages, or for lost profits, revenue or data.

8.2 Each party's total liability under this Agreement is capped at the fees paid by the Client for the services giving rise to the claim in the {{liability_cap_months}} months before the event. This cap does not apply to breaches of Section 5, to amounts owed under Section 3, or to liability that cannot be limited by law.

### 9. General

9.1 This Agreement is governed by the laws of {{venue}}, and the parties submit to the courts of {{venue}}.

9.2 Neither party may assign this Agreement without the other's written consent, except to a successor in a merger or sale of substantially all assets.

9.3 This Agreement, together with its Orders and addenda, is the entire agreement between the parties on its subject and supersedes prior discussions.

### 10. Acceptance

Accepted for the Client by {{signer_name}} on {{accepted_date}}.

Questions about this Agreement go to {{msp_name}} at {{msp_email}}.`;

const BAA_BODY = `## HIPAA Business Associate Agreement

This Business Associate Agreement (the "BAA") is made between **{{client_legal_name}}** (the "Covered Entity") and **{{msp_legal_name}}** of {{msp_address}} (the "Business Associate"), effective as of {{effective_date}}, and supplements the services agreement between the parties.

Capitalised terms used but not defined here have the meanings given in the Health Insurance Portability and Accountability Act of 1996 and its implementing regulations at 45 CFR Parts 160 and 164, each as amended ("HIPAA").

### 1. Permitted Uses and Disclosures

1.1 The Business Associate may use and disclose Protected Health Information ("PHI") only as necessary to perform the services, as permitted by this BAA, or as Required by Law.

1.2 The Business Associate may use PHI for its own proper management and administration, and may disclose it for those purposes where the disclosure is Required by Law or the recipient gives reasonable written assurances of confidentiality and breach notification.

1.3 The Business Associate will not use or disclose PHI in a manner that would violate Subpart E of 45 CFR Part 164 if done by the Covered Entity.

### 2. Safeguards

2.1 The Business Associate will use appropriate administrative, physical and technical safeguards, and will comply with Subpart C of 45 CFR Part 164 (the Security Rule) with respect to electronic PHI, to prevent use or disclosure other than as provided by this BAA.

### 3. Reporting

3.1 The Business Associate will report to the Covered Entity any use or disclosure of PHI not provided for by this BAA of which it becomes aware, including Breaches of Unsecured PHI as required by 45 CFR § 164.410, and any Security Incident of which it becomes aware.

3.2 Breach reports will be made without unreasonable delay and in no case later than {{breach_notice_days}} days after discovery, and will include the information the Covered Entity needs to meet its own notification obligations.

### 4. Subcontractors

4.1 The Business Associate will ensure that any subcontractor that creates, receives, maintains or transmits PHI on its behalf agrees in writing to restrictions and conditions at least as protective as those in this BAA, as required by 45 CFR §§ 164.502(e)(1)(ii) and 164.308(b)(2).

### 5. Individual Rights

5.1 The Business Associate will make PHI in a Designated Record Set available to the Covered Entity as necessary to satisfy obligations under 45 CFR § 164.524 (access), § 164.526 (amendment) and § 164.528 (accounting of disclosures), within reasonable timeframes agreed with the Covered Entity.

### 6. Books and Records

6.1 The Business Associate will make its internal practices, books and records relating to the use and disclosure of PHI available to the Secretary of Health and Human Services for purposes of determining compliance with HIPAA.

### 7. Term and Termination

7.1 This BAA takes effect on the effective date above and continues until the underlying services agreement ends or this BAA is terminated under this section.

7.2 The Covered Entity may terminate this BAA, and the underlying services as they relate to PHI, if the Business Associate materially breaches this BAA and fails to cure within {{cure_period_days}} days of written notice.

7.3 On termination, the Business Associate will return or destroy all PHI it still maintains, if feasible. Where return or destruction is not feasible, the protections of this BAA extend to that PHI for as long as it is maintained, and uses and disclosures are limited to the purposes that make return or destruction infeasible.

### 8. Miscellaneous

8.1 Nothing in this BAA creates rights in third parties. Any ambiguity is resolved to permit compliance with HIPAA. This BAA controls over the services agreement for PHI matters.

### 9. Acceptance

Accepted for the Covered Entity by {{signer_name}} on {{accepted_date}}.

Questions about this BAA go to {{msp_name}} at {{msp_email}}.`;

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    slug: "msa",
    kind: "msa",
    title: "Master Service Agreement",
    variables: {
      payment_terms_days: "30",
      notice_period_days: "60",
      cure_period_days: "30",
      liability_cap_months: "12",
    },
    bodyMarkdown: MSA_BODY,
  },
  {
    slug: "hipaa-baa",
    kind: "hipaa-baa",
    title: "HIPAA Business Associate Agreement",
    variables: {
      breach_notice_days: "30",
      cure_period_days: "30",
    },
    bodyMarkdown: BAA_BODY,
  },
] as const;

export function starterTemplate(slug: string): StarterTemplate | null {
  return STARTER_TEMPLATES.find((t) => t.slug === slug) ?? null;
}
