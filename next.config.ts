import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-hosted: produce a standalone server bundle so `docker run` or a bare
  // `node .next/standalone/server.js` works without the full node_modules.
  output: "standalone",

  // App-wide framing headers, scoped to EXCLUDE the two public embed routes.
  //
  // The source literal below MUST stay character-identical to
  // NON_EMBED_HEADER_SOURCE in src/lib/legal/embedRoutes.ts —
  // tests/legal/embedRoutes.test.ts asserts both the text and the regex's
  // match behaviour. It is a literal rather than an import because a Next
  // config import graph is loaded before the app's module resolution, and a
  // bad import here fails the build instead of a test.
  //
  // Why the exemption exists: a Next config header REPLACES a route
  // handler's header of the same key. /legal/embed/frame computes its
  // `Content-Security-Policy: frame-ancestors` from the operator's settings
  // row; an app-wide `frame-ancestors 'self'` matching that path would
  // silently overwrite it and the embed would never render on the MSP's
  // website — which is exactly the 11-month silent bug this pattern fixed
  // upstream (ShadowPSA STA-9551).
  async headers() {
    return [
      {
        source: "/:path((?!legal/embed/frame$|legal/embed\\.js$).*)",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
