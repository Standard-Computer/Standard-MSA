// WCAG 2.2 relative luminance and contrast ratio, from the spec, with no
// dependency — the whole point of this file is that the readability bar is
// MEASURED in CI rather than eyeballed in a review.
//
// Underscore-prefixed so the `tests/**/*.test.ts` runner glob skips it, the
// same convention as tests/auth/_actionSplit.ts.
//
// Definitions: WCAG 2.2 SC 1.4.3 (Contrast Minimum, AA) wants 4.5:1 for
// normal text and 3:1 for large text (>=18.66px bold or >=24px). AAA (SC
// 1.4.6) wants 7:1 / 4.5:1. This app's secondary text is set at .8em-.875em,
// so "large" never applies to it and AA_NORMAL is the floor that matters.

export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;
export const AAA_NORMAL = 7;

/** sRGB 8-bit channel -> linear-light value. WCAG 2.x definition. */
function channel(eightBit: number): number {
  const c = eightBit / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Accepts "#rgb" and "#rrggbb", case-insensitive. */
export function parseHex(hex: string): [number, number, number] {
  const raw = hex.trim().replace(/^#/, "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`not a hex colour: ${JSON.stringify(hex)}`);
  }
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1..21. Order-independent. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

/** Rounded to 2dp so failure messages read like the numbers in the PR. */
export function ratio(a: string, b: string): number {
  return Math.round(contrast(a, b) * 100) / 100;
}
