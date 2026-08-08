import type { NextConfig } from 'next';

const config: NextConfig = {
  typedRoutes: false,
  // This project sits inside a tree that has its own lockfile two directories
  // up. Without this, Next walks up, finds it, and roots file tracing outside
  // the project.
  outputFileTracingRoot: import.meta.dirname,
  experimental: {
    // Server Actions are how every mutation in this app runs. The default body
    // limit is 1MB; submissions carry an abstract and a bio, nothing larger.
    serverActions: { bodySizeLimit: '1mb' },
  },
};

export default config;
