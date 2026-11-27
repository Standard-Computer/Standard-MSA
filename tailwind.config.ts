import type { Config } from "tailwindcss";

// Sean's ruling (2026-11-27, GH #19): "Light mode by default. Make the text
// readable, no gray fonts." Light mode was already the default — the defect
// was 121 `text-slate-400/500/600` class uses spread over 25 page and
// component files, i.e. gray body copy on every screen.
//
// WHY A TOKEN REMAP AND NOT A FIND-AND-REPLACE. Rewriting 121 class strings
// would fix today's files and nothing else: the next page written in this
// repo reaches for `text-slate-500` again — it is what every Tailwind
// example uses for secondary text — and the gray is back with no test able
// to see it coming. Remapping the token fixes the screens that exist AND the
// ones that do not, which is what AC 7 ("body color cannot silently return
// to muted gray") actually asks for. tests/ui/readable-text.test.ts pins
// every value below against the measured WCAG ratio.
//
// WHY `textColor` AND NOT `colors`. Overriding `theme.colors.slate` would
// drag every other utility along with it, and two of them must NOT move:
//
//   disabled:bg-slate-400   three submit buttons — a near-black "disabled"
//                           background reads as enabled
//   focus:border-slate-500  an input focus ring
//
// `textColor` is its own theme key (it defaults to `theme('colors')`), so
// restricting the override to it leaves `bg-*`, `border-*` and `ring-*`
// resolving to stock slate. The full scale is written out rather than
// spread over the default: a partial object replaces the `slate` key
// outright, and a dropped shade is a SILENT failure — `text-slate-900`
// would stop emitting a colour rather than error.
//
// THE RAMP. Three readable tiers instead of a light-to-dark gradient that
// runs out of contrast at the top. Ratios are measured against white
// (#ffffff), the operator surface, by tests/ui/_contrast.ts:
//
//   body / labels / table cells  600,700,800,900 -> #0f172a  17.85:1  AAA
//   secondary meta               500             -> #334155  10.35:1  AAA
//   de-emphasised state          300,400         -> #475569   7.58:1  AAA
//
// Stock slate-400 measured 2.56:1 — below AA's 3:1 floor for even large
// text, so `text-slate-400` ("(blank)", "revoked", zero-count funnel cells,
// the wizard's future-step chips) was failing outright, not merely soft.
// Stock slate-500 measured 4.76:1: AA by 0.26 and exactly the "small meta
// at text-slate-500 on white" AC 3 rejects by name.
//
// The tiers stay ordered (300/400 lighter than 500, 500 lighter than 600+)
// so existing emphasis still reads; what is gone is the unreadable end of
// the scale. Hierarchy below the body tier now comes from size and weight,
// not from washing the colour out.
//
// Shades 50-200 are untouched: they are the light text on this app's dark
// surfaces (`bg-slate-900 text-slate-100`, 16.30:1) and must stay light.
const READABLE_SLATE_TEXT: Record<string, string> = {
  "50": "#f8fafc",
  "100": "#f1f5f9",
  "200": "#e2e8f0",
  "300": "#475569", // was #cbd5e1 (1.48:1)
  "400": "#475569", // was #94a3b8 (2.56:1 — failed AA outright)
  "500": "#334155", // was #64748b (4.76:1 — the "gray font")
  "600": "#0f172a", // was #475569 (7.58:1, still visibly gray)
  "700": "#0f172a", // was #334155
  "800": "#0f172a", // was #1e293b
  "900": "#0f172a",
  "950": "#020617",
};

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      textColor: {
        slate: READABLE_SLATE_TEXT,
      },
    },
  },
  plugins: [],
};

export { READABLE_SLATE_TEXT };
export default config;
