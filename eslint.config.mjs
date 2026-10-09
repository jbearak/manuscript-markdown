import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["out/**", "**/*.js", "**/*.mjs", "**/*.test.ts"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "off",
      "no-useless-escape": "off",
      "no-restricted-syntax": ["error",
        {
          selector: "CallExpression[callee.property.name=/^(push|unshift|splice)$/] > SpreadElement",
          message: "A spread into push, unshift or splice passes each item as an argument, which throws past about 120,000 in Node. Use pushAll or spliceAll from arrays.ts, or a loop. Where a constant or something small bounds the items, say what in an eslint-disable-next-line comment.",
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name=/^(max|min)$/] > SpreadElement",
          message: "A spread into Math.max or Math.min passes each value as an argument, which throws past about 120,000 in Node. Use maxOf from arrays.ts, or a loop. Where a constant or something small bounds the values, say what in an eslint-disable-next-line comment.",
        },
        {
          selector: "CallExpression[callee.object.name='Object'][callee.property.name='assign'] > SpreadElement",
          message: "A spread into Object.assign passes each object as an argument, which throws past about 120,000 in Node. Assign them in a loop. Where a constant or something small bounds the objects, say what in an eslint-disable-next-line comment.",
        },
        {
          selector: "CallExpression[callee.object.name='String'][callee.property.name=/^fromC(harCode|odePoint)$/] > SpreadElement",
          message: "A spread into String.fromCharCode or String.fromCodePoint passes each code as an argument, which throws past about 120,000 in Node. Build the string in chunks, or a loop. Where a constant or something small bounds the codes, say what in an eslint-disable-next-line comment.",
        },
      ],
    },
  }
);
