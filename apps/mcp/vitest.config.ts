import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/app/**/layout.tsx', 'src/app/**/page.tsx'],
      // Set at the current floor, not an aspirational target: the job of these
      // numbers is to fail the build when coverage regresses. Ratchet them up
      // as gaps are closed; never lower one to make a build pass.
      thresholds: { lines: 58, functions: 60, branches: 70, statements: 58 },
    },
  },
});
