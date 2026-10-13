import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['development'],
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  // DOM tests are `test/**/*.test.tsx` and opt in to jsdom with a `// @vitest-environment jsdom` docblock; `.test.ts` stays on node.
  test: { include: ['test/**/*.test.{ts,tsx}'] },
});
