"use client";

// The shared operator chrome (SHA-4503, GH #17): a collapsible left nav around
// every signed-in screen, and nothing at all around the public ones.
//
// Why this sits in the ROOT layout rather than in a `(operator)` route group:
// the group would mean moving every operator page into a new directory, which
// collides with the other lanes building in `src/app/documents` and
// `src/app/sends` right now, and the root layout is the only layout that wraps
// `/` itself. So one mount point, and the public/operator decision is asked of
// `showsOperatorNav()` — i.e. of `src/lib/auth/surfaces.ts`, the same registry
// that decides whether a path needs an operator session.
//
// This component renders NO operator data: the nav is a static table of module
// names and hrefs (src/lib/nav/nav.ts), so shipping it to the client reveals
// nothing, and the gate still runs server-side as the first statement of every
// operator page. It renders no `<main>` either — each page brings its own.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { navCollapsedCookie } from "@/lib/nav/collapse";
import { NAV_ICON_PATHS } from "@/lib/nav/icons";
import { activeItemId, NAV, showsOperatorNav, type NavItem } from "@/lib/nav/nav";

function NavGlyph({ id }: { id: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={NAV_ICON_PATHS[id]} />
    </svg>
  );
}

function NavRow({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  return (
    <li>
      <Link
        href={item.href}
        // The label is the accessible name in both states: when collapsed it
        // is visually hidden rather than removed, so the rail is still a list
        // of named links to a screen reader. `title` covers the mouse.
        title={collapsed ? item.label : undefined}
        aria-current={active ? "page" : undefined}
        {...(item.newTab ? { target: "_blank", rel: "noreferrer" } : {})}
        className={`flex items-center gap-3 rounded-md px-2 py-2 text-sm ${
          collapsed ? "justify-center" : ""
        } ${
          active
            ? "bg-slate-200 font-medium text-slate-900"
            : "text-slate-700 hover:bg-slate-100"
        }`}
      >
        <NavGlyph id={item.id} />
        <span className={collapsed ? "sr-only" : "truncate"}>{item.label}</span>
        {item.newTab && !collapsed ? (
          // Drawn, not typed: U+2197 ↗ is not in the default font stack and
          // rendered as a tofu box.
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="ml-auto h-3 w-3 shrink-0 text-slate-400"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M7 17 17 7M9 7h8v8" />
          </svg>
        ) : null}
      </Link>
    </li>
  );
}

/**
 * Wraps `children` in the operator chrome, or passes them straight through on
 * a public surface.
 *
 * `initialCollapsed` comes from the cookie the root layout read, so the first
 * paint is already correct — see src/lib/nav/collapse.ts.
 */
export function OperatorShell({
  initialCollapsed,
  children,
}: {
  initialCollapsed: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  if (!showsOperatorNav(pathname)) return <>{children}</>;

  const active = activeItemId(pathname);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = navCollapsedCookie(
      next,
      window.location.protocol === "https:",
    );
  };

  return (
    <div className="flex min-h-screen">
      <aside
        className={`flex shrink-0 flex-col border-r border-slate-200 bg-slate-50 ${
          collapsed ? "w-16" : "w-60"
        }`}
      >
        <div
          className={`flex items-center gap-2 px-3 py-4 ${
            collapsed ? "flex-col" : ""
          }`}
        >
          <Link
            href="/"
            title={collapsed ? "Standard-MSA" : undefined}
            aria-current={pathname === "/" ? "page" : undefined}
            className="flex items-center gap-2 rounded-md px-1 py-1 font-semibold text-slate-900 hover:bg-slate-100"
          >
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-slate-900 text-xs font-bold text-white"
            >
              MSA
            </span>
            <span className={collapsed ? "sr-only" : "truncate text-sm"}>
              Standard-MSA
            </span>
          </Link>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-controls="operator-nav"
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            className={`rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 ${
              collapsed ? "" : "ml-auto"
            }`}
          >
            <span aria-hidden="true">{collapsed ? "»" : "«"}</span>
          </button>
        </div>

        <nav id="operator-nav" aria-label="Modules" className="px-2 pb-4">
          {NAV.map((section) => (
            <div key={section.id} className="mt-2 first:mt-0">
              {section.label === null ? null : (
                <h2
                  className={`px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-500 ${
                    collapsed ? "sr-only" : ""
                  }`}
                >
                  {section.label}
                </h2>
              )}
              {section.label !== null && collapsed ? (
                <hr aria-hidden="true" className="mx-2 my-2 border-slate-200" />
              ) : null}
              <ul className="space-y-0.5">
                {section.items.map((item) => (
                  <NavRow
                    key={item.id}
                    item={item}
                    active={item.id === active}
                    collapsed={collapsed}
                  />
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
