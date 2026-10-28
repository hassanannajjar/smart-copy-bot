import type { NextConfig } from 'next';

// Native module: keep it out of the server bundle.
const config: NextConfig = { serverExternalPackages: ['better-sqlite3'] };

export default config;
