"use client";

// The shared operator chrome: a collapsible left nav around every console
// screen (SHA-4496, GH #17).
//
// It is one client component wrapped around `children` in the root layout
// rather than a route group, because moving ~18 page files into an
// `(operator)/` directory would collide with every lane in flight and change
// no behaviour. The cost is that the decision "does this path get chrome?"
// is made here instead of by the file system — so it is made by asking
// src/lib/auth/surfaces.ts, the same registry the auth gate asks, rather than
// by a list kept in this file.
//
// AUTH: this renders no data. It is a static list of links, identical for
// every request, and it holds no session check of its own — the page's own
// requireOperator() still runs first and redirects before any of this
// reaches a browser without a session (tests/auth/coverage.test.ts holds
// every operator page to that call). Nothing here weakens or replaces it.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useSyncExternalStore } from "react";

import {
  NAV_COLLAPSED_CLASS,
  NAV_COLLAPSED_VALUE,
  NAV_COLLAPSE_STORAGE_KEY,
} from "@/lib/nav/collapse";
import {
  activeNavHref,
  NAV_LINKS,
  shouldRenderOperatorNav,
  type NavIcon,
  type NavLink,
} from "@/lib/nav/operatorNav";

/**
 * The glyph for each nav icon: a 24×24 stroke path on `currentColor`.
 *
 * Hand-written rather than pulled from an icon package — the rail needs ten
 * shapes and this repo ships self-hosted, so a dependency for ten `<path d>`
 * strings would be a worse trade. Keyed as a Record on NavIcon, so a new
 * link with an unknown icon fails typecheck rather than rendering a blank.
 */
const ICON_PATHS: Record<NavIcon, readonly string[]> = {
  dashboard: ["M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"],
  onboarding: ["M12 3a4 4 0 110 8 4 4 0 010-8z", "M4.5 21a7.5 7.5 0 0115 0"],
  legal: ["M12 3l7 3v5.5c0 4.8-2.9 8-7 9.5-4.1-1.5-7-4.7-7-9.5V6z", "M9 12l2 2 4-4"],
  visits: ["M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z", "M12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"],
  publicSite: ["M12 3a9 9 0 100 18 9 9 0 000-18z", "M3.5 9h17M3.5 15h17", "M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"],
  email: ["M3 5.5h18v13H3z", "M3 6.5l9 6 9-6"],
  documents: ["M7 3h7l5 5v13H7z", "M14 3v5h5", "M10 13h6M10 17h6"],
  sends: ["M21 3L3 10.5l7.5 3L13.5 21z", "M21 3l-10.5 10.5"],
  api: ["M8.5 4C5.5 6 5.5 10 7.5 12c-2 2-2 6 1 8", "M15.5 4c3 2 3 6 1 8 2 2 2 6-1 8", "M12 10v4"],
  identity: [
    "M12 9a3 3 0 100 6 3 3 0 000-6z",
    "M12 2.5v2.8M12 18.7v2.8M4.3 6.3l2 2M17.7 15.7l2 2M2.5 12h2.8M18.7 12h2.8M4.3 17.7l2-2M17.7 8.3l2-2",
  ],
};

function Glyph({ icon }: { icon: NavIcon }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="h-5 w-5 shrink-0"
    >
      {ICON_PATHS[icon].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="nav-chevron h-5 w-5 shrink-0"
    >
      <path d="M14.5 6.5L9 12l5.5 5.5" />
    </svg>
  );
}

// ── The collapse state, as an external store ────────────────────────────────
//
// The authoritative copy of "is the menu collapsed?" is the class on <html>,
// because an inline script put it there before React existed on the page
// (src/lib/nav/collapse.ts). So React READS it rather than owning it, through
// useSyncExternalStore — which is what that hook is for, and which keeps the
// read out of an effect. The earlier version of this used
// `useState(false)` + an effect that called setState on mount; it worked, but
// it is the cascading-render pattern react-hooks warns about, and it made the
// DOM the source of truth while pretending React was.
//
// getServerSnapshot returns false: there is no localStorage on the server, so
// the HTML always says "expanded". The rail still PAINTS collapsed, because
// the class is applied before this markup is parsed and the width comes from
// CSS; React reconciles `aria-expanded` right after hydration.

const collapseListeners = new Set<() => void>();

function readCollapsed(): boolean {
  return document.documentElement.classList.contains(NAV_COLLAPSED_CLASS);
}

function readCollapsedOnServer(): boolean {
  return false;
}

function readStoredCollapsed(): boolean {
  try {
    return window.localStorage.getItem(NAV_COLLAPSE_STORAGE_KEY) === NAV_COLLAPSED_VALUE;
  } catch {
    // Storage denied (private mode, sandboxed frame): treat as expanded.
    return false;
  }
}

function setCollapsed(next: boolean): void {
  document.documentElement.classList.toggle(NAV_COLLAPSED_CLASS, next);
  try {
    if (next) {
      window.localStorage.setItem(NAV_COLLAPSE_STORAGE_KEY, NAV_COLLAPSED_VALUE);
    } else {
      window.localStorage.removeItem(NAV_COLLAPSE_STORAGE_KEY);
    }
  } catch {
    // The toggle still works for this page; it just will not be remembered.
  }
  for (const listener of collapseListeners) listener();
}

function subscribeCollapse(onStoreChange: () => void): () => void {
  collapseListeners.add(onStoreChange);
  // Another tab collapsing the menu is a change to the same stored state.
  // `key === null` is a whole-storage clear, which also counts.
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== NAV_COLLAPSE_STORAGE_KEY) return;
    document.documentElement.classList.toggle(NAV_COLLAPSED_CLASS, readStoredCollapsed());
    onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    collapseListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

function NavItem({ link, current }: { link: NavLink; current: boolean }) {
  // Every label stays in the DOM in both states. When the rail is collapsed
  // CSS clips it (globals.css) instead of hiding it, so it is still the
  // link's accessible name for a screen reader — `display: none` would take
  // the name away and leave ten unlabelled icons.
  const label = <span className="nav-label truncate">{link.label}</span>;
  const shared = [
    "group flex items-center gap-3 rounded-md px-3 py-2 text-sm",
    link.child ? "nav-child pl-8" : "",
    current
      ? "bg-slate-200 font-medium text-slate-900"
      : "text-slate-700 hover:bg-slate-100 hover:text-slate-900",
  ].join(" ");

  if (link.publicSite) {
    // The MSP's own public site (AC 2). A plain anchor, not next/link: it
    // leaves the console, and rel=noreferrer keeps the operator path out of
    // the referer even though the destination is the same origin today.
    return (
      <a
        href={link.href}
        title={link.hint}
        target="_blank"
        rel="noreferrer"
        className={shared}
      >
        <Glyph icon={link.icon} />
        {label}
      </a>
    );
  }

  return (
    <Link
      href={link.href}
      title={link.hint}
      aria-current={current ? "page" : undefined}
      className={shared}
    >
      <Glyph icon={link.icon} />
      {label}
    </Link>
  );
}

function OperatorNav({ pathname }: { pathname: string }) {
  const listId = useId();
  const collapsed = useSyncExternalStore(
    subscribeCollapse,
    readCollapsed,
    readCollapsedOnServer,
  );
  const current = activeNavHref(pathname);

  return (
    <nav
      aria-label="Modules"
      className="nav-rail sticky top-0 flex h-screen shrink-0 flex-col gap-1 overflow-y-auto border-r border-slate-200 bg-slate-50 px-2 py-3 transition-[width] duration-150"
    >
      <div className="flex items-center justify-between gap-1 px-1 pb-2">
        <span className="nav-label truncate text-sm font-semibold text-slate-900">
          Standard-MSA
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          aria-controls={listId}
          className="rounded-md p-1.5 text-slate-600 hover:bg-slate-200 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
        >
          <Chevron />
          {/* Always hidden visually, always present as the accessible name;
              aria-expanded carries the state, so the name never has to. */}
          <span className="sr-only">Toggle navigation menu</span>
        </button>
      </div>
      <ul id={listId} className="flex flex-col gap-0.5">
        {NAV_LINKS.map((link) => (
          <li key={link.href}>
            <NavItem link={link} current={link.href === current} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function OperatorShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Public surfaces render exactly as they did before this lane (AC 1).
  if (!shouldRenderOperatorNav(pathname)) return <>{children}</>;
  return (
    <div className="flex min-h-screen">
      <OperatorNav pathname={pathname} />
      {/* min-w-0 so a wide table inside a page cannot push the rail off. */}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
