// The operator navigation table (SHA-4503, GH #17).
//
// Two of the six modules on the home page — the legal embed generator at
// `/embed` and email delivery at `/settings/email` — were built, shipped and
// then unreachable, because `src/app/page.tsx` carried them as cards with
// `href: null` and there was no nav. A card list whose links are optional is
// how that happens, so this file replaces it with a table where a link is the
// only way to describe a module: `href` is required, and the home dashboard
// renders FROM this table rather than from a second list beside it.
//
// tests/nav/nav.test.ts holds the table against the real route tree: every
// operator screen under src/app must be a nav destination here or be named in
// that file's NAV_SUB_SCREENS with the reason it is reached from a parent.
// A new module therefore cannot ship unlinked by omission.
//
// Pure and dependency-free on purpose: the shell that renders it is a client
// component (src/components/nav/OperatorShell.tsx), so nothing here may reach
// for the database, `next/headers` or anything else server-only.

import { classifyPath, matchesPattern } from "@/lib/auth/surfaces";

/** A dashboard card on `/`, for the modules that warrant a description. */
export interface NavCard {
  /** Card heading. Deliberately free of the nav label: the nav says
   *  "Embed & settings" under a Legal heading, the card says "/legal site". */
  readonly title: string;
  readonly body: string;
}

export interface NavItem {
  /** Stable key for the icon map and for the active-section comparison. */
  readonly id: string;
  /** What the nav shows when expanded, and the accessible name when not. */
  readonly label: string;
  readonly href: string;
  /**
   * Further route patterns this item is the nav home of, in the `surfaces.ts`
   * pattern language, used only for the current-section indicator. `/sends`
   * stays highlighted while the operator is on `/sends/42`.
   */
  readonly owns?: readonly string[];
  /**
   * Leaves the console. The public legal site has no operator chrome by
   * design (see `surfaces.ts`), so following it in this tab would be a dead
   * end with no way back; it opens in a new tab and is never "current".
   */
  readonly newTab?: boolean;
  /** Present = this module also gets a card on the `/` dashboard. */
  readonly card?: NavCard;
}

export interface NavSection {
  readonly id: string;
  /** Visible group heading, or `null` for the ungrouped top block. */
  readonly label: string | null;
  readonly items: readonly NavItem[];
}

/**
 * Every destination in the operator nav.
 *
 * The seven names Sean asked for are all here: Onboarding, Legal (a group),
 * Email delivery, Documents, MSA sends, API, and Settings / Identity.
 */
export const NAV: readonly NavSection[] = [
  {
    id: "console",
    label: null,
    items: [
      {
        id: "onboarding",
        label: "Onboarding",
        href: "/onboarding",
        card: {
          title: "Onboarding",
          body: "MSP identity, contract header preview, venue. Re-run any time.",
        },
      },
      {
        id: "documents",
        label: "Documents",
        href: "/documents",
        owns: ["/documents/**"],
        card: {
          title: "Documents",
          body:
            "Author the MSA / HIPAA BAA: drafts, preview, publish, version " +
            "history. Starter templates included.",
        },
      },
      {
        id: "sends",
        label: "MSA sends",
        href: "/sends",
        owns: ["/sends/**"],
        card: {
          title: "MSA sends",
          body:
            "Unique per-recipient MSAs with full lifecycle tracking and " +
            "acceptance evidence.",
        },
      },
    ],
  },
  {
    id: "legal",
    label: "Legal",
    items: [
      {
        id: "legal-embed",
        label: "Embed & settings",
        href: "/embed",
        card: {
          title: "/legal site",
          body:
            "Public legal pages, website embed generator, visitor log, " +
            "liveness monitor.",
        },
      },
      {
        id: "legal-visits",
        label: "Visitor log",
        href: "/visits",
        owns: ["/visits/**"],
      },
      {
        id: "legal-public",
        label: "Public site",
        href: "/legal",
        newTab: true,
      },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      {
        id: "settings-identity",
        label: "Identity",
        href: "/settings/identity",
      },
      {
        id: "settings-email",
        label: "Email delivery",
        href: "/settings/email",
        card: {
          title: "Email delivery",
          body:
            "SMTP2GO / SendGrid / SMTP — configured at runtime, keys from env " +
            "only.",
        },
      },
      {
        id: "settings-api",
        label: "API",
        href: "/settings/api",
        card: {
          title: "API",
          body:
            "API keys, OpenAPI spec and webhooks for PSA/AI tools to create " +
            "MSA sends.",
        },
      },
    ],
  },
] as const;

/** Every item, flattened, in nav order. */
export function navItems(): readonly NavItem[] {
  return NAV.flatMap((section) => section.items);
}

/**
 * The `/` dashboard, derived from the nav rather than listed beside it.
 *
 * This is the whole fix for the `href: null` cards: a card exists only as a
 * property of a nav destination, so it carries that destination's link.
 */
export function dashboardCards(): ReadonlyArray<NavItem & { card: NavCard }> {
  return navItems().filter(
    (item): item is NavItem & { card: NavCard } => item.card !== undefined,
  );
}

/**
 * Does `pathname` get the operator chrome?
 *
 * Asked of `surfaces.ts` rather than answered with a list here, which is the
 * point: the registry that decides whether a path needs an operator session is
 * the registry that decides whether it shows operator navigation. A new public
 * route is classified there (held by tests/auth/coverage.test.ts) and stays
 * bare; a new operator screen is classified there and gets the nav for free.
 *
 * `refusal: "redirect"` narrows it to SCREENS: `/visits/export` and
 * `/sends/[id]/evidence` are operator-gated downloads, not pages.
 */
export function showsOperatorNav(pathname: string): boolean {
  const surface = classifyPath(pathname);
  return surface.kind === "operator" && surface.refusal === "redirect";
}

/**
 * Which nav item is the current section, or `null` for none.
 *
 * The most specific match wins, counted in path segments, so `/settings/email`
 * beats a hypothetical `/settings` entry. `/` is deliberately no item: the
 * dashboard is the shell's brand link.
 */
export function activeItemId(pathname: string): string | null {
  const path = pathname.split("?")[0].split("#")[0];
  let best: { id: string; depth: number } | null = null;
  for (const item of navItems()) {
    if (item.newTab) continue;
    for (const pattern of [item.href, ...(item.owns ?? [])]) {
      if (!matchesPattern(pattern, path)) continue;
      const depth = pattern.split("/").filter((s) => s !== "").length;
      if (best === null || depth > best.depth) best = { id: item.id, depth };
    }
  }
  return best === null ? null : best.id;
}
