// Starter document templates (SHA-3086). PURE.
//
// A fresh self-hosted install has ZERO documents — nothing to publish,
// nothing to send. These templates are the starting matter: the operator
// imports one as their own DRAFT, edits it, and nothing is visible anywhere
// until they publish. Sean's SHA-2970 ruling put both the MSA and the HIPAA
// BAA in v1, so both ship here; SHA-4501 added the website terms, for the
// case where there is no client to sign at all.
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

// SHA-4501. The no-known-client case: a public website where there is no
// signer, no countersignature and no send — continued use IS the acceptance.
//
// Both templates above are bilateral agreements and end "Accepted for the
// Client by {{signer_name}} on {{accepted_date}}", which is exactly wrong
// here: on the public surface those tokens render as "the Client's
// authorized signatory" and "the date of acceptance", describing a signature
// that nobody gives. So this body carries NO signature block. It uses only
// MSP tokens and the generic client wording, which is what makes it read
// correctly on /legal, in the embed and in a PDF download, where the reader
// is whoever happens to be visiting.
//
// It does not replace the MSA: section 5 says so, because an MSP that
// publishes website terms still signs a services agreement with each client,
// and terms that quietly claimed to govern paid services would contradict it.
const WEBSITE_TERMS_BODY = `## Website Terms of Use

These Terms of Use (the "Terms") govern access to and use of the website and related public pages operated by **{{msp_legal_name}}** of {{msp_address}} ("we", "us"). Please read them before using the site.

### 1. Acceptance by Use

1.1 By accessing or continuing to use the site, you agree to these Terms. If you do not agree to them, please stop using the site.

1.2 There is nothing to sign. Your continued use of the site after these Terms, or any later version of them, are published is your acceptance of the version then in force.

1.3 Where you also have a signed agreement with us, that agreement — not these Terms — governs the services it covers. See section 5.

### 2. Who We Are

2.1 The site is operated by {{msp_name}}. Our published contact address for notices about the site is {{msp_email}}, and our website is {{msp_website}}.

### 3. Permitted Use

3.1 You may use the site to read about our services, to contact us, and for any other purpose we make available on it.

3.2 You agree not to attempt to gain unauthorised access to the site or to any system or account connected to it, not to interfere with its availability for others, and not to use automated means to collect information from it in a way that places an unreasonable load on it.

3.3 We may suspend or withdraw all or part of the site at any time, with or without notice. We do not undertake that the site will be available uninterrupted.

### 4. Changes to These Terms

4.1 We may change these Terms. The version published on the site is the version in force, and each version carries the date it took effect.

4.2 Where a change is material, we will publish it at least {{terms_change_notice_days}} days before it takes effect, so that anyone relying on the current version has notice of it.

4.3 Earlier versions remain available on the site so you can see what the Terms said when you used it previously. Your continued use of the site after a change takes effect is your acceptance of the changed Terms.

### 5. Services Are Governed Separately

5.1 These Terms cover the site itself. They are not an offer of services, they do not create a services relationship, and they do not amend any agreement we have signed with you.

5.2 Paid services are governed by the Master Service Agreement, order form, quote or other written agreement between us and the client receiving them. Where those terms and these Terms conflict, those terms control for the services they cover.

5.3 Nothing on the site is a quote or a binding price unless it is in a written agreement or quote signed or confirmed by us.

### 6. Our Content

6.1 The content of the site — text, layout, graphics, logos and the selection and arrangement of them — belongs to us or to our licensors, and is protected by copyright and trade mark law.

6.2 You may read, print and share pages of the site for your own information, including a copy of these Terms. Any other substantial reproduction, republication or commercial use needs our written permission.

6.3 Material you send us through the site — an enquiry, a request or a document — stays yours. You give us permission to use it to respond to you and to provide the services you ask about.

### 7. No Professional Advice

7.1 The site is published for general information. It is not technical, security, legal, tax or compliance advice for any particular situation, and it is not a substitute for advice about your own systems or obligations.

7.2 Do not act on the site's content alone where the decision matters. Ask us, or ask your own adviser.

### 8. No Warranty for the Site

8.1 The site and its content are provided as they are. To the extent the law allows, we give no warranty that the site is accurate, complete, current, uninterrupted or free of error.

8.2 This section is about the SITE. Warranties for services we actually perform are in the agreement that covers those services, and this section does not reduce them.

### 9. Limitation of Liability

9.1 To the extent the law allows, we are not liable for indirect, incidental or consequential loss, or for lost profits, revenue, data or goodwill, arising out of your use of the site.

9.2 Nothing in these Terms limits liability that cannot be limited by law, including liability for death or personal injury caused by negligence, or for fraud.

9.3 Liability for services is governed by the agreement that covers those services, not by this section.

### 10. Links to Other Sites

10.1 The site may link to sites we do not operate. We include a link because it may be useful, not as an endorsement, and we are not responsible for the content or practices of a site we do not control.

### 11. Visitors and Privacy

11.1 We keep a record of visits to the pages on which our published agreements appear — the page, the time, and technical details sent by your browser — so that we can show which version of a document was published when it was read.

11.2 We use that record for that purpose and for the security and operation of the site. We do not sell it. Questions about it go to {{msp_email}}.

### 12. Governing Law

12.1 These Terms are governed by the laws of {{venue}}, and the courts of {{venue}} have jurisdiction over any dispute about them.

### 13. General

13.1 If any part of these Terms is unenforceable, the rest continues to apply.

13.2 These Terms are between you and {{msp_legal_name}}. They give no rights to anybody else.

### 14. Contact

Questions about these Terms, or about anything on the site, go to {{msp_name}} at {{msp_email}}.`;

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
  {
    slug: "website-terms",
    kind: "website-terms",
    title: "Website Terms of Use",
    variables: {
      // A default to edit, not a rule: the number of days' notice before a
      // material change takes effect.
      terms_change_notice_days: "14",
    },
    bodyMarkdown: WEBSITE_TERMS_BODY,
  },
] as const;

export function starterTemplate(slug: string): StarterTemplate | null {
  return STARTER_TEMPLATES.find((t) => t.slug === slug) ?? null;
}
