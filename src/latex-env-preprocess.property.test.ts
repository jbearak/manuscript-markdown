import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { wrapBareLatexEnvironments } from './latex-env-preprocess';
import { parseMd } from './md-to-docx';

describe('wrapBareLatexEnvironments property tests', () => {
	test('idempotent: applying twice equals applying once', () => {
		const envNames = ['equation', 'align', 'align*', 'gather', 'cases', 'matrix'];
		const envArb = fc.constantFrom(...envNames);
		const contentArb = fc.string({ maxLength: 30 }).map(s =>
			s.replace(/\\begin\{/g, '').replace(/\\end\{/g, '')
		);

		fc.assert(
			fc.property(envArb, contentArb, (env: string, content: string) => {
				const input = '\\begin{' + env + '}\n' + content + '\n\\end{' + env + '}';
				const once = wrapBareLatexEnvironments(input);
				const twice = wrapBareLatexEnvironments(once);
				expect(twice).toBe(once);
			}),
			{ numRuns: 200 }
		);
	});

	test('text without \\begin{ is always unchanged', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 100 }), (text: string) => {
				fc.pre(!text.includes('\\begin{'));
				expect(wrapBareLatexEnvironments(text)).toBe(text);
			}),
			{ numRuns: 200 }
		);
	});

	test('wrapped output always contains $$ delimiters around the environment', () => {
		const envNames = ['equation', 'align*', 'gather', 'cases'];
		const envArb = fc.constantFrom(...envNames);
		const contentArb = fc.string({ maxLength: 20 }).map(s =>
			s.replace(/\\begin\{/g, '').replace(/\\end\{/g, '').replace(/\$/g, '')
		);

		fc.assert(
			fc.property(envArb, contentArb, (env: string, content: string) => {
				const input = '\\begin{' + env + '}\n' + content + '\n\\end{' + env + '}';
				const result = wrapBareLatexEnvironments(input);
				expect(result).toContain('$$\\begin{' + env + '}');
				expect(result).toContain('\\end{' + env + '}$$');
			}),
			{ numRuns: 200 }
		);
	});

	test('wraps an environment with escaped dollar signs before dollar signs before it, in it and after it, which export reads as display math', () => {
		// A backslash and two dollar signs, which open and close no math
		const escaped = '\\$' + '$';
		const display = '$' + '$';
		const envArb = fc.constantFrom('equation', 'align*', 'gather', 'cases');
		const textArb = fc.array(fc.constantFrom('a', ' ', '5', escaped), { maxLength: 6 }).map(parts => parts.join(''));
		fc.assert(
			fc.property(envArb, textArb, textArb, textArb, (env: string, before: string, inside: string, after: string) => {
				const input = 'p' + before + '\n\n\\begin{' + env + '}\nx' + inside + '\n\\end{' + env + '}\n\nq' + after + '\n';
				const result = wrapBareLatexEnvironments(input);
				expect([input, result.includes(display + '\\begin{' + env + '}') && result.includes('\\end{' + env + '}' + display)]).toEqual([input, true]);
				const math = parseMd(input).flatMap(token => token.runs).filter(run => run.type === 'math' && run.display);
				expect([input, math.length]).toEqual([input, 1]);
			}),
			{ numRuns: 200 }
		);
	});
});
