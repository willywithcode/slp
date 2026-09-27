import { defineConfig } from "vitest/config";

// Flow tests drive real git in temporary repositories; CI runners (Windows
// especially) can take several seconds per test.
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 60_000 },
});
