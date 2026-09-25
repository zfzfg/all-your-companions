// Correctness-only lint rules. No style rules: formatting is not enforced, and
// a formatter run over the existing code would rewrite every line.
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "out/**",
      "out-integration/**",
      ".vscode-test/**",
      "media/mermaid/**",
      "media/mathjax/**",
      "**/*.min.js",
      "adapters/**",
      "integration/**",
      "research/**",
    ],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-fallthrough": ["error", { allowEmptyCase: true }],
      "no-constant-condition": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
    },
  },
  {
    files: ["media/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, ...globals.commonjs, acquireVsCodeApi: "readonly" },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-dupe-keys": "error",
      "no-unreachable": "error",
    },
  },
  {
    files: ["media/pcm-worklet.js"],
    languageOptions: { globals: globals.audioWorklet },
  },
  {
    files: ["resources/**/*.cjs", "scripts/**/*.{js,cjs}"],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: globals.node },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-dupe-keys": "error",
      "no-unreachable": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: globals.node },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-dupe-keys": "error",
      "no-unreachable": "error",
    },
  },
  {
    // Playwright drivers: the callbacks handed to page.evaluate run in the page.
    files: ["scripts/*-screens.mjs", "scripts/ui-harness/**/*.mjs", "scripts/marketplace-publish.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
