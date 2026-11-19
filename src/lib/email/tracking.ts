// Open/click tracking instrumentation (SHA-2958) — the C5 hooks.
//
// Click wrapping stores the real targets on the outbound row and rewrites
// links to /api/email/click/<outboundId>/<index>. The click route redirects
// only to a stored target and enforces absolute http(s) URLs, so a caller
// passing an arbitrary trackLinks value cannot create an open redirect.

export function clickUrl(baseUrl: string, outboundId: string, index: number): string {
  return `${baseUrl}/api/email/click/${outboundId}/${index}`;
}

export function openPixelUrl(baseUrl: string, outboundId: string): string {
  return `${baseUrl}/api/email/open/${outboundId}`;
}

/** Rewrite each tracked URL (href="..." and bare occurrences) in the html. */
export function wrapLinks(
  html: string,
  links: string[],
  baseUrl: string,
  outboundId: string,
): string {
  let out = html;
  links.forEach((target, index) => {
    out = out.split(target).join(clickUrl(baseUrl, outboundId, index));
  });
  return out;
}

export function appendOpenPixel(html: string, baseUrl: string, outboundId: string): string {
  const img = `<img src="${openPixelUrl(baseUrl, outboundId)}" width="1" height="1" alt="" style="display:none" />`;
  if (html.includes("</body>")) return html.replace("</body>", `${img}</body>`);
  return html + img;
}

/** 1x1 transparent GIF served by the open-pixel route. */
export const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
