import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-hosted: produce a standalone server bundle so `docker run` or a bare
  // `node .next/standalone/server.js` works without the full node_modules.
  output: "standalone",
};

export default nextConfig;
