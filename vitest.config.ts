import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources (not the compiled
// dist). Without this, tests load TWO copies of a package — the source (via
// direct src imports) and dist (via the package name) — and `instanceof`
// checks across the copies fail (e.g. the gateway's ProviderHttpError
// check, which is what makes fallback work).
const src = (pkg: string) =>
  path.resolve(__dirname, `packages/${pkg}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@jhinuk-ai-router\/provider-sdk$/, replacement: src('provider-sdk') },
      { find: /^@jhinuk-ai-router\/protocols$/, replacement: src('protocols') },
      { find: /^@jhinuk-ai-router\/shared$/, replacement: src('shared') },
      { find: /^@jhinuk-ai-router\/config$/, replacement: src('config') },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    poolOptions: {
      threads: { singleThread: true },
    },
  },
});
