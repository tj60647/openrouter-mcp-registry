import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      // React page/component trees are excluded: this workspace runs under the
      // node environment with no DOM, so counting thousands of untestable JSX
      // lines would drown out the server-side logic the threshold is guarding.
      include: ['src/lib/**/*.ts', 'src/app/api/**/*.ts', 'src/middleware.ts'],
      exclude: ['src/**/__tests__/**'],
      // Set at the current floor, not an aspirational target: the job of these
      // numbers is to fail the build when coverage regresses. Ratchet them up
      // as gaps are closed; never lower one to make a build pass.
      thresholds: { lines: 63, functions: 67, branches: 64, statements: 63 },
    },
  },
});
