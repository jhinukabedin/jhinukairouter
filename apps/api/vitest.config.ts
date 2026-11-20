import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Same as the root config: resolve workspace packages to their TypeScript
// sources so tests never load a second copy from dist (which breaks
// `instanceof` checks, e.g. the gateway's ProviderHttpError check).
const src = (pkg: string) =>
  path.resolve(__dirname, `../../packages/${pkg}/src/index.ts`);

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
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 15000,
  },
});
