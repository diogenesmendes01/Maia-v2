/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  pageExtensions: ['ts', 'tsx'],
  // `standalone` lets the production Dockerfile copy a minimal Node runtime
  // (`.next/standalone/server.js` + its node_modules subset) into a small
  // image instead of dragging the full repo's node_modules. Required by
  // the dedicated admin-ui container for Coolify (`src/admin-ui/Dockerfile`).
  output: 'standalone',
  experimental: {
    serverActions: {
      allowedOrigins: ['localhost:4000', 'localhost:3000'],
    },
  },
  // ESM-style imports across the admin-ui use the .js extension on .ts files
  // (consistent with the root tsconfig "module: NodeNext" + tsc-alias output).
  // Next's webpack default doesn't resolve `.js` → `.ts(x)`; this alias does.
  // Without it, `next build` / `next dev` fail with "Module not found" on
  // every internal import.
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;
