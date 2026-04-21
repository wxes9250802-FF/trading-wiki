/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Prevent Next.js bundler from inlining pino and its worker-thread transports.
    // Without this, importing the logger from a route handler breaks production
    // build with "Cannot find module 'thread-stream'" and similar errors.
    // Reference: https://github.com/pinojs/pino/issues/1841
    // NOTE: In Next.js 15+ this moves to top-level `serverExternalPackages`.
    serverComponentsExternalPackages: [
      "pino",
      "pino-pretty",
      "thread-stream",
      "pino-worker",
      "pino-file",
      "real-require",
    ],
  },
};

export default nextConfig;
