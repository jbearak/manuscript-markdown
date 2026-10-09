import { describe, expect, test } from 'bun:test';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

// A spread into push, unshift or splice, Math.max or Math.min,
// String.fromCharCode or String.fromCodePoint, or Object.assign passes each
// item as an argument, which Node, the extension's runtime, holds on its
// stack, and past about 120,000 it throws (see arrays.ts and
// spread-limit.test.ts). The lint rule in eslint.config.mjs finds each, so
// one whose items grow with a document goes through pushAll, maxOf,
// spliceAll or a loop, and one a constant or something small bounds says
// what in the comment that allows it.

const configPath = '../eslint.config.mjs';
const config: Array<{ rules?: Record<string, Linter.RuleEntry> }> = (await import(configPath)).default;
const restricted = config.find(entry => entry.rules?.['no-restricted-syntax'])?.rules?.['no-restricted-syntax'];
const linter = new Linter({ configType: 'flat' });

/** Whether the rule finds `code` */
const found = (code: string) => linter.verify(code, [{
  files: ['**/*.ts'],
  languageOptions: { parser: tseslint.parser },
  rules: { 'no-restricted-syntax': restricted! },
}], { filename: 'src/x.ts' }).some(message => message.ruleId === 'no-restricted-syntax');

describe('The lint rule against spreads into calls', () => {
  test('is in the config', () => {
    expect(restricted).toBeDefined();
  });

  test.each([
    'a.push(...b);',
    'a.unshift(...b);',
    'a.splice(0, 1, ...b);',
    'this.tokens.splice(i, 0, x, ...b);',
    'Math.max(...b);',
    'Math.min(0, ...b);',
    'String.fromCharCode(...b);',
    'String.fromCodePoint(...b);',
    'Object.assign({}, ...b);',
  ])('finds %s', code => {
    expect(found(code)).toBe(true);
  });

  test.each([
    'pushAll(a, b);',
    'a.push(b, c);',
    'a.push({ ...o });',
    'const c = [...a, ...b];',
    'f(...b);',
    'Math.max(a, b);',
    'Object.assign({}, a, b);',
    '// eslint-disable-next-line no-restricted-syntax -- two at most\na.push(...b);',
  ])('passes %s', code => {
    expect(found(code)).toBe(false);
  });
});
