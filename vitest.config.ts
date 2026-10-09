import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "data/**"],
    // Several files spawn real Agent/CLI fixtures. Bound file-level fanout on
    // large, shared hosts without relaxing deadlines or in-test concurrency.
    maxWorkers: 2,
  },
});
