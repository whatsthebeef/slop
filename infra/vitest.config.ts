import { defineConfig } from 'vitest/config';

// Each CDK synth takes seconds on a cold CI runner running the other packages' tests in parallel; the 5s default timed out on main.
export default defineConfig({ test: { testTimeout: 30_000 } });
