const isDev = process.env.NODE_ENV !== 'production';

// Content-Security-Policy (Q11). The console is operator-attended, not public; this
// locks the default surface while allowing what the app actually needs: inline
// styles (Tailwind/Kumo), data/blob images, and outbound https/wss to chain RPC +
// the Nado gateway. Dev also needs 'unsafe-eval' + ws: for React Refresh / HMR.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' https: wss:${isDev ? ' ws:' : ''}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  // HSTS only in production (localhost is plain http in dev).
  ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The workspace packages are consumed as TypeScript source, so Next must transpile them.
  transpilePackages: ['@farm/ui', '@farm/core', '@farm/adapter-api', '@farm/adapter-nado'],
  // The live server route (app/api/nado/*) unlocks a wative workspace and drives the
  // Nado SDK server-side; keep these as Node requires (not bundled) — wative-core/node
  // has native/node-only deps, and the SDK ships its own CJS/ESM dual build.
  serverExternalPackages: ['wative-core', '@nadohq/client', '@nadohq/engine-client', 'bignumber.js'],
  // The workspace source uses ESM `.js` import specifiers that resolve to `.ts` files;
  // teach webpack to try the TS extensions first.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};
export default nextConfig;
