// ESLint flat config, following the ShadowPSA convention (Next 16 removed
// `next lint`; `npm run lint` is plain `eslint .`): next/core-web-vitals +
// eslint-plugin-security recommended + TS-aware unused-identifier checks.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import pluginSecurity from "eslint-plugin-security";
import tseslint from "typescript-eslint";

const UNUSED_IDENTIFIERS = {
  args: "after-used",
  varsIgnorePattern: "^_",
  argsIgnorePattern: "^_",
  caughtErrors: "none",
};

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...nextCoreWebVitals,
  pluginSecurity.configs.recommended,
  {
    // Same repo-wide stance as ShadowPSA: computed member access on internal
    // keys is not the injection risk this rule hunts; request input is Zod-
    // validated at the boundary instead.
    rules: { "security/detect-object-injection": "off" },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", UNUSED_IDENTIFIERS],
    },
  },
];

export default config;
