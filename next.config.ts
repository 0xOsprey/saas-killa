import type { NextConfig } from 'next';

const config: NextConfig = {
  typedRoutes: false,
  // This project sits inside a tree that has its own lockfile two directories
  // up. Without this, Next walks up, finds it, and roots file tracing outside
  // the project.
  outputFileTracingRoot: import.meta.dirname,
  experimental: {
    // Server Actions are how every mutation in this app runs, uploads included,
    // so this ceiling has to clear the largest one: a 25MB slide deck plus the
    // rest of its form. It is a global limit, which is the price of keeping
    // uploads on actions rather than on a route handler — an action carries
    // Next's own origin check, and a route handler taking multipart POSTs would
    // need that written by hand. The real per-kind caps are in
    // `src/lib/uploads.ts`, and they are what a speaker is refused against.
    serverActions: { bodySizeLimit: '30mb' },
  },
};

export default config;
