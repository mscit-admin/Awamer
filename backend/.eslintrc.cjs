/**
 * ESLint (legacy config, ESLint 8 + typescript-eslint 7).
 *
 * Pragmatic baseline for a previously-unlinted service: real-bug rules are
 * errors; stylistic/DX rules are warnings so `npm run lint` reports a backlog
 * without blocking. Ratchet warnings → errors over time.
 */
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: ["dist", "node_modules", "*.cjs", "*.config.*"],
  rules: {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-empty-function": "off",
    "no-empty": ["warn", { allowEmptyCatch: true }],
    "no-constant-condition": ["error", { checkLoops: false }],
    // Control-char classes are used intentionally in filename/label sanitizers.
    "no-control-regex": "off",
  },
};
