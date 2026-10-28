import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // emulator-backed tests (rules, integration) are slow to start
    testTimeout: 90_000, // first call of each emulated function can take several seconds on Windows
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
