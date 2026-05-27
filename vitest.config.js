import { defineConfig } from "vitest/config";

// NOTE on DEP0040: vitest spawns worker processes for each test file and
// many transitive deps still import `punycode`. We can't pass --disable-warning
// to those workers via vitest config. Workers inherit NODE_OPTIONS, so we
// set it in the test scripts in package.json (`NODE_OPTIONS=--disable-warning=DEP0040`).

export default defineConfig({
  test: {
    globalSetup: ["./tests/_globals.js"],
  },
});
