import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(here, "../.."),
  },
  // Emit a self-contained server bundle at .next/standalone for the
  // Dockerfile — keeps the image small without us having to copy node_modules.
  output: "standalone",
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "berrie-ai-incorporated.litellm-sandbox.ai",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
