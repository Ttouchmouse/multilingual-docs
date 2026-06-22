import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/local-translations": ["./20260108_번역.html"],
  },
};
nextConfig.turbopack = {
  root: process.cwd(),
};

export default nextConfig;
