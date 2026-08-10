// Two build modes on top of the normal dev/server build:
//
//   EURO_STATIC_EXPORT=1  → a fully static bundle (used by the Capacitor shell)
//   EURO_BASE_PATH=/x     → serve the site from a sub-path
//
// GitHub Pages serves this project at https://<user>.github.io/euro_trade/,
// i.e. a SUB-PATH, not a domain root. Without basePath every script, stylesheet
// and image resolves to /_next/... and 404s — the page loads blank. The Flutter
// build handled the same thing with `--base-href /euro_trade/`.
const isStaticExport = process.env.EURO_STATIC_EXPORT === '1';
const basePath = process.env.EURO_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(isStaticExport ? { output: 'export', images: { unoptimized: true } } : {}),
  ...(basePath ? { basePath, assetPrefix: `${basePath}/` } : {}),

  reactStrictMode: true,

  // The engine and shared packages ship as TypeScript source, not build output,
  // so Next has to compile them alongside the app.
  transpilePackages: ['@euro/engine', '@euro/shared'],

  // Exposed to the client so components can prefix static assets (e.g. the
  // splash logo) that Next does not rewrite automatically.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },

  webpack: (config) => {
    // Those packages use ESM-correct specifiers (`./math.js` from math.ts).
    // Webpack resolves them literally and finds nothing, so map each `.js`
    // request onto its TypeScript source first.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },

  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
  },
};

export default nextConfig;
