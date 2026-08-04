/**
 * ESLint (legacy config, matches the installed ESLint 8 + typescript-eslint 7).
 *
 * Deliberately pragmatic for a large, previously-unlinted codebase: real-bug
 * rules are errors, stylistic/DX rules are warnings so `npm run lint` surfaces
 * a backlog without blocking. Ratchet warnings → errors over time.
 */
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  plugins: ["@typescript-eslint", "react-hooks", "react-refresh"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: ["dist", "src-tauri", "node_modules", "*.config.*", "*.cjs"],
  rules: {
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-empty-function": "off",
    "no-empty": ["warn", { allowEmptyCatch: true }],
  },
};
