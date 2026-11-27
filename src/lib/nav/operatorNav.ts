// The operator console's navigation map (SHA-4496, GH #17).
//
// /embed and /settings/email shipped working and then sat unreachable from
// the console, because "the module exists" and "the module is linked" were
// two independent facts kept in two places — a route directory and a card
// list whose `href` was allowed to be null. This file makes them one fact:
//
//   * the left nav renders from NAV_LINKS,
//   * the home dashboard renders from MODULE_CARDS, whose `href` is a
//     required string, so a card with no destination will not type-check,
//   * tests/nav/links.test.ts walks src/app and fails when an operator
//     SCREEN is neither linked here nor a sub-screen of something that is.
//
// That last rule is the one that closes the omission rather than fixing its
// two instances: a new operator screen cannot reach main unlinked without a
// test going red.
//
// This is data in a plain .ts module, not JSX, for two reasons. The suite
// only collects tests/**/*.test.ts, so a .tsx nav would be untestable here;
// and the predicates below are wanted by the client shell and by tests
// alike, with no React in the way.

import { classifyPath } from "../auth/surfaces";

/**
 * Which glyph the rail draws. The shapes live with the component
 * (src/components/nav/OperatorShell.tsx) as a Record keyed on this union, so
 * adding a link with a new icon is a type error until the shape exists.
 */
export type NavIcon =
  | "dashboard"
  | "onboarding"
  | "legal"
  | "visits"
  | "publicSite"
  | "email"
  | "documents"
  | "sends"
  | "api"
  | "identity";

export interface NavLink {
  readonly label: string;
  /** An absolute app path. Never null — see the note at the top of the file. */
  readonly href: string;
  readonly icon: NavIcon;
  /** One line of help, used as the link's `title`. */
  readonly hint: string;
  /**
   * Indented under the preceding top-level link (the Legal group, GH #17
   * AC 2). Children are still drawn in the collapsed rail: collapsing the
   * menu must not take a screen away.
   */
  readonly child?: true;
  /**
   * Deliberately points at a PUBLIC surface — the MSP's own live legal site,
   * which AC 2 asks to be reachable from the Legal group. Opens in a new tab,
   * and is the only exception to the rule that every nav link is an operator
   * screen (asserted both ways in tests/nav/links.test.ts).
   */
  readonly publicSite?: true;
}

/**
 * Every module in the console, in menu order.
 *
 * The seven destinations Sean named in GH #17 AC 2 are all here: Onboarding,
 * Legal, Email delivery, Documents, MSA sends, API, and Settings / Identity.
 */
export const NAV_LINKS: readonly NavLink[] = [
  {
    label: "Dashboard",
    href: "/",
    icon: "dashboard",
    hint: "Every module at a glance.",
  },
  {
    label: "Onboarding",
    href: "/onboarding",
    icon: "onboarding",
    hint: "The MSP identity wizard. Re-run it any time.",
  },
  {
    label: "Legal",
    href: "/embed",
    icon: "legal",
    hint: "Website embed snippet, allowed origins, liveness monitor.",
  },
  {
    label: "Visitor log",
    href: "/visits",
    icon: "visits",
    hint: "Who viewed the public legal pages, with CSV export.",
    child: true,
  },
  {
    label: "Public /legal site",
    href: "/legal",
    icon: "publicSite",
    hint: "The public index your clients see. Opens in a new tab.",
    child: true,
    publicSite: true,
  },
  {
    label: "Email delivery",
    href: "/settings/email",
    icon: "email",
    hint: "SMTP2GO / SendGrid / SMTP. Provider keys stay in environment variables.",
  },
  {
    label: "Documents",
    href: "/documents",
    icon: "documents",
    hint: "Author, preview and publish the MSA / HIPAA BAA.",
  },
  {
    label: "MSA sends",
    href: "/sends",
    icon: "sends",
    hint: "Per-recipient MSAs, lifecycle and acceptance evidence.",
  },
  {
    label: "API",
    href: "/settings/api",
    icon: "api",
    hint: "API keys, the OpenAPI spec and webhooks.",
  },
  {
    label: "Settings / Identity",
    href: "/settings/identity",
    icon: "identity",
    hint: "MSP identity, contract header preview and venue.",
  },
];

export interface ModuleCard {
  readonly title: string;
  readonly body: string;
  /**
   * Required, deliberately not `string | null`. The v0 home page allowed null
   * and two modules shipped with it set — this type is what stops that
   * recurring, and the test holds every value to a real nav destination.
   */
  readonly href: string;
  /** The delivery lane that built it (docs/ARCHITECTURE.md § Module boundaries). */
  readonly lane: string;
}

/** The home dashboard's cards. Every one links somewhere (GH #17 AC 5). */
export const MODULE_CARDS: readonly ModuleCard[] = [
  {
    title: "Onboarding",
    body: "MSP identity, contract header preview, venue. Re-run any time.",
    lane: "SHA-2956",
    href: "/settings/identity",
  },
  {
    title: "/legal site",
    body: "Public legal pages, website embed generator, visitor log, liveness monitor.",
    lane: "SHA-2957",
    href: "/embed",
  },
  {
    title: "Email delivery",
    body: "SMTP2GO / SendGrid / SMTP — configured at runtime, keys from env only.",
    lane: "SHA-2958",
    href: "/settings/email",
  },
  {
    title: "Documents",
    body: "Author the MSA / HIPAA BAA: drafts, preview, publish, version history. Starter templates included.",
    lane: "SHA-3086",
    href: "/documents",
  },
  {
    title: "MSA sends",
    body: "Unique per-recipient MSAs with full lifecycle tracking and acceptance evidence.",
    lane: "SHA-2959",
    href: "/sends",
  },
  {
    title: "API",
    body: "API keys, OpenAPI spec and webhooks for PSA/AI tools to create MSA sends.",
    lane: "SHA-2960",
    href: "/settings/api",
  },
];

/**
 * Does the console chrome belong on this path? (GH #17 AC 1.)
 *
 * Asked of the request surface registry rather than of a hand-kept list, so
 * the nav and the auth gate can never disagree about what an operator screen
 * is. `/legal/**`, `/msa/[token]`, `/login` and `/setup` are classified
 * public, so they get no nav — which is the point: the public legal site and
 * the recipient's agreement must not grow the MSP's internal menu, and the
 * login screen must not advertise the console's shape to a stranger.
 *
 * `refusal === "redirect"` narrows `operator` to screens. The two operator
 * surfaces refused with a 401 (`/visits/export`, `/sends/[id]/evidence`) are
 * route handlers serving a download; no layout runs for them, and asking for
 * chrome around a CSV would be asking the wrong question.
 *
 * An unclassified path falls through to UNMATCHED, which is operator +
 * redirect, so an unknown console path keeps its chrome. That is the safe
 * direction here: the nav is a static list of links and reveals nothing the
 * gate would not already have refused.
 */
export function shouldRenderOperatorNav(pathname: string): boolean {
  const surface = classifyPath(pathname);
  return surface.kind === "operator" && surface.refusal === "redirect";
}

/**
 * Is `pathname` inside the section `href` names?
 *
 * Exact match, or a sub-screen one segment down. The trailing slash is what
 * keeps `/settings/email` from claiming `/settings/email-digest`, and `/` is
 * exact-only so the Dashboard does not light up on every page.
 */
export function isActiveNavHref(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The nav link to mark as current (GH #17 AC 5), or null off-menu.
 *
 * Longest match wins, so a future `/settings` landing page would not steal
 * `current` from `/settings/email`.
 */
export function activeNavHref(pathname: string): string | null {
  let best: string | null = null;
  for (const link of NAV_LINKS) {
    if (!isActiveNavHref(link.href, pathname)) continue;
    if (best === null || link.href.length > best.length) best = link.href;
  }
  return best;
}
