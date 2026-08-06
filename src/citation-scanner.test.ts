import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
	findCitationAtOffset,
	getCitationCompletionContextAtOffset,
	hasBibliographyDemand,
	scanCitationDocument,
} from './citation-scanner';

function keys(text: string): string[] {
	return scanCitationDocument(text).usages.map(usage => usage.key);
}

describe('citation document scanner', () => {
	test('recognizes the exporter-supported bracket subset and narrative citations', () => {
		const text = 'See [@alpha; -@beta, p. 2] and @gamma.\nAlso [-@delta; @epsilon].';
		const usages = scanCitationDocument(text).usages;
		expect(usages.map(usage => [usage.key, usage.form, usage.suppressAuthor])).toEqual([
			['alpha', 'bracket', false],
			['beta', 'bracket', true],
			['gamma', 'bare', false],
			['delta', 'bracket', true],
			['epsilon', 'bracket', false],
		]);
		expect(keys('[see @unsupported]')).toEqual([]);
		expect(keys('[@alpha; see @beta]')).toEqual(['alpha']);
		expect(keys('[@alpha, text mentioning @beta]')).toEqual(['alpha']);
	});

	test('uses escape-aware balanced bracket contexts', () => {
		expect(keys('\\[literal opener then @escaped_open')).toEqual(['escaped_open']);
		expect(keys('[unmatched opener then @unmatched_open')).toEqual(['unmatched_open']);
		expect(keys('[ordinary @hidden] then @visible')).toEqual(['visible']);
		expect(keys('[discussion [@nested]]')).toEqual(['nested']);
		expect(keys('[outer [ordinary] @hidden]')).toEqual([]);
		expect(keys('`[` then @visible ]')).toEqual(['visible']);
	});

	test('recognizes supported top-level nocite forms and wildcard', () => {
		const forms = [
			'nocite: @alpha',
			'nocite : @alpha',
			'nocite: "@alpha"',
			"nocite: '[@alpha; @beta]'",
			'nocite: |\n  @alpha\n  @beta',
			'nocite: >-\n  @alpha\n  @beta',
			'nocite:\n- @alpha\n- "@beta"',
			'nocite:\n  - @alpha\n  - "@beta"',
		];
		for (const form of forms) {
			const text = '---\n' + form + '\n---\nBody';
			expect(keys(text)).toEqual(form.includes('@beta') ? ['alpha', 'beta'] : ['alpha']);
			expect(hasBibliographyDemand(text)).toBe(true);
		}

		const wildcard = scanCitationDocument("---\nnocite: '@*'\n---\nBody");
		expect(wildcard.usages).toEqual([]);
		expect(wildcard.hasNociteWildcard).toBe(true);
		expect(hasBibliographyDemand("---\nnocite: '@*'\n---\nBody")).toBe(true);
	});

	test('keeps closed and provisionally unclosed YAML citation analysis in parity', () => {
		const yaml = [
			"title: '@hidden'",
			"nocite: '[@alpha; @*]'",
			'other: @also-hidden',
		].join('\n');
		const scans = [
			scanCitationDocument('---\n' + yaml + '\n---'),
			scanCitationDocument('---\n' + yaml),
		];
		for (const scan of scans) {
			expect(scan.usages.map(usage => usage.key)).toEqual(['alpha']);
			expect(scan.hasNociteWildcard).toBe(true);
		}

		for (const suffix of ["'\n---", "'"]) {
			const text = "---\ntitle: '@hidden'\nnocite: '@alp" + suffix;
			expect(getCitationCompletionContextAtOffset(text, text.lastIndexOf("'"))).toMatchObject({
				prefix: 'alp', form: 'nocite',
			});
			expect(getCitationCompletionContextAtOffset(text, text.indexOf("'", text.indexOf('title')))).toBeUndefined();
		}
	});

	test('preserves thematic-break body semantics until a mapping establishes frontmatter', () => {
		const text = '---\nBody prose with @visible';
		expect(keys(text)).toEqual(['visible']);
		expect(getCitationCompletionContextAtOffset(text, text.length)?.form).toBe('bare');
	});

	test('handles nocite comments, colon-bearing list keys, and block-scalar boundaries', () => {
		const text = [
			'---',
			'nocite: # bibliography-only entries',
			'  - "@org:paper" # keep this one',
			'  - @beta',
			'title: "@not-nocite"',
			'---',
		].join('\n');
		expect(keys(text)).toEqual(['org:paper', 'beta']);

		const block = [
			'---',
			'nocite: |+ # @indicator-comment',
			'  @alpha',
			'# @outside-block',
			'title: Draft',
			'---',
		].join('\n');
		expect(keys(block)).toEqual(['alpha']);
	});

	test('applies citation boundaries and escaping to every nocite form', () => {
		const invalid = [
			'person@example.com',
			'"quoted.local"@example.com',
			'δοκιμή@example.org',
			'café@example.com',
			'café@example.com',
			'é@smith',
			'é@smith',
			'\\@escaped',
			'name@*suffix',
			'δοκιμή@*',
		];
		const forms = [
			'nocite: ' + invalid.join(' '),
			'nocite: [' + invalid.join(', ') + ']',
			'nocite:\n' + invalid.map(value => '  - ' + value).join('\n'),
			'nocite: |\n' + invalid.map(value => '  ' + value).join('\n'),
		];
		for (const form of forms) {
			const text = '---\n' + form + '\n---\nBody';
			expect(scanCitationDocument(text)).toEqual({ usages: [], hasNociteWildcard: false });
		}

		const valid = '---\nnocite: [@alpha, -@beta, @*]\n---\n';
		expect(keys(valid)).toEqual(['alpha', 'beta']);
		expect(scanCitationDocument(valid).hasNociteWildcard).toBe(true);
	});

	test('treats general YAML and nested nocite mappings as inert', () => {
		const text = [
			'---',
			'author: person@example.com',
			'title: "@not-a-citation"',
			'settings:',
			'  nocite: @nested',
			'---',
			'Body',
		].join('\n');
		expect(scanCitationDocument(text)).toEqual({ usages: [], hasNociteWildcard: false });
	});

	test('excludes false-positive bare contexts while preserving body offsets', () => {
		const text = [
			'Email user@example.com.',
			'URL https://example.com/@url and mailto:@mail.',
			'Path docs/@path and escaped \\@escaped.',
			'Inline `@inline`.',
			'',
			'    @indented',
			'```md',
			'@fenced',
			'```',
			'[link](@destination)',
			'[ref]: @definition',
			'<!-- @html-comment -->',
			'<span data-cite="@attribute">@visible</span>',
			'{>>@Reviewer | comment<<}',
			'{#one>>@Another Reviewer (2026-01-01) | comment<<}',
			'Valid @narrative and [-@suppressed].',
		].join('\n');
		const usages = scanCitationDocument(text).usages;
		expect(usages.map(usage => usage.key)).toEqual(['visible', 'narrative', 'suppressed']);
		for (const usage of usages) {
			expect(text.slice(usage.atStart, usage.keyEnd)).toBe('@' + usage.key);
			expect(usage.keyStart).toBe(usage.atStart + 1);
		}
	});

	test('builds foundational inert ranges before secondary structural ranges', () => {
		for (const hidden of [
			'`<!--`',
			'`<span data-x="`',
			'`](`',
			'`{>>@Reviewer |`',
		]) {
			expect(keys(hidden + ' then @live')).toEqual(['live']);
		}
		const frontmatter = '---\ntitle: "<!--"\ncode: "]("\nreview: "{>>@R |"\n---\n@live';
		expect(keys(frontmatter)).toEqual(['live']);
		expect(keys('<!-- ]( --> @live')).toEqual(['live']);
		expect(keys('<!--\n```\n-->\n@live')).toEqual(['live']);
		expect(keys('<span data-value="]( @hidden">body</span> @live')).toEqual(['live']);
		expect(keys('<span data-value="<!--">body</span> @live')).toEqual(['live']);
	});

	test('scans footnote bodies but not ordinary reference definitions', () => {
		expect(keys('[^note]: See @footnote.')).toEqual(['footnote']);
		expect(keys('[reference]: @destination')).toEqual([]);
	});

	test('only activates full-reference labels for valid Markdown definitions', () => {
		const reference = 'See [work by @alpha][target].\n\n';
		for (const definition of [
			'[target]: https://example.test',
			'[target]: <https://example.test> "A title"',
			'[target]:\n  https://example.test\n  "A multiline definition"',
		]) {
			expect(keys(reference + definition)).toEqual(['alpha']);
		}

		for (const definition of [
			'[target]:',
			'[target]: https://example.test trailing garbage',
			'[target]: <https://example.test',
			'[target]: https://example.test/(unclosed',
			'[target]: javascript:alert(1)',
			'[target]: file:///tmp/manuscript.md',
		]) {
			expect(keys(reference + definition)).toEqual([]);
		}

		expect(keys('See [work by @hidden][^note].\n\n[^note]: /url\n[^body]: See @footnote.'))
			.toEqual(['footnote']);
	});

	test('excludes destinations while scanning bare citations in visible link labels', () => {
		const text = '[See @label](https://example.test/@destination "@title")';
		expect(scanCitationDocument(text).usages.map(usage => [usage.key, usage.form])).toEqual([
			['label', 'bare'],
		]);
		expect(keys('[Visible][@destination]')).toEqual([]);
		expect(keys('See [work by @shortcut].\n\n[work by @shortcut]: https://example.test')).toEqual(['shortcut']);
		expect(keys('See [work by @ordinary].\n\n```\n[work by @ordinary]: /url\n```')).toEqual([]);
		expect(keys('[Label](https://example.test\n  "@title") @live')).toEqual(['live']);
		expect(keys('[Label](\n@destination\n) @live')).toEqual(['live']);
		expect(keys('[Label](https://example.test\n"@title"\n) @live')).toEqual(['live']);
		expect(keys('[Label](foo"bar@hidden) @live')).toEqual(['live']);
		expect(keys('[Label](foo<bar@hidden) @live')).toEqual(['live']);
		expect(keys('[Label](foo>bar@hidden) @live')).toEqual(['live']);
		expect(keys('[Label](foo bar@hidden) @live')).toEqual(['live']);
		expect(keys('[Label](<foo bar@hidden>) @live')).toEqual(['live']);
		expect(keys('[ref]: https://example.test\n  "@title"\n@live')).toEqual(['live']);
		expect(keys('[ref]:\n  @destination\n  "@title"\n@live')).toEqual(['live']);
		expect(keys('[ref]:\n      @destination\n@live')).toEqual(['live']);
			expect(keys('[ref]:\n\t@destination\n@live')).toEqual(['live']);
			expect(keys('[ref]:\n@destination\n@live')).toEqual(['live']);
		expect(keys('[label](<https://example.test/@hidden(>) @live')).toEqual(['live']);
		expect(keys('[label](https://example.test/@hidden "title (") @live')).toEqual(['live']);
		expect(keys('[label](not a valid destination @live)')).toEqual(['live']);
		expect(keys('[see @hidden](not a valid destination) @live')).toEqual(['live']);
		expect(keys('[see @hidden][missing] @live')).toEqual(['live']);
		expect(keys('[see @linked][known] @live\n\n[known]: /url')).toEqual(['linked', 'live']);
		expect(keys('Ordinary punctuation ]( followed by @live')).toEqual(['live']);
	});

	test('excludes only CriticMarkup attribution headers', () => {
		const text = [
			'{++added @addition++}',
			'{--deleted @deletion--}',
			'{~~old @old~>new @new~~}',
			'{==marked @highlight==}',
			'{>>@Reviewer | comment cites @comment<<}',
		].join(' ');
		expect(keys(text)).toEqual(['addition', 'deletion', 'old', 'new', 'highlight', 'comment']);
	});

	test('ends CriticMarkup attribution recognition at the first newline', () => {
		expect(keys('{>>@Reviewer | body @comment<<}')).toEqual(['comment']);
		expect(keys('{>>@body_citation\n| later pipe<<}')).toEqual(['body_citation']);
		expect(keys('{>>  \n@body_citation | later<<}')).toEqual(['body_citation']);
	});

	test('does not mistake quoted, Unicode, or decomposed email addresses for citations', () => {
		const text = '"quoted.local"@example.com. δοκιμή@example.org. 用户@example.net 𐐀@example.dev '
			+ 'café@example.com café@example.com cafe@examplé.test cafe@examplé.test '
			+ 'but “@citation” and (@other).';
		expect(keys(text)).toEqual(['citation', 'other']);
	});

	test('rejects bare and nocite markers attached to Unicode letters, marks, or numbers', () => {
		const supplementaryMark = String.fromCodePoint(0x1D165);
		expect(/\p{M}/u.test(supplementaryMark)).toBe(true);
		const attached = [
			'α@_beta',
			'𐐀@deseret',
			'٣@arabic',
			'𝟙@astral_number',
			'é@precomposed',
			'é@decomposed',
			'a' + supplementaryMark + '@supplementary_mark',
		];
		expect(keys(attached.join(' '))).toEqual([]);
		for (const value of attached) {
			const bodyOffset = value.length;
			expect(getCitationCompletionContextAtOffset(value, bodyOffset)).toBeUndefined();
			const nocite = "---\nnocite: '" + value + "'\n---\n";
			expect(scanCitationDocument(nocite)).toEqual({ usages: [], hasNociteWildcard: false });
			expect(getCitationCompletionContextAtOffset(nocite, nocite.indexOf("'\n"))).toBeUndefined();
		}
	});

	test('does not mistake ordinary indented continuations for code', () => {
		expect(keys('- List item\n    Continued with @list_citation.')).toEqual(['list_citation']);
		expect(keys('- List item\n\n    Continued with @list_paragraph.')).toEqual(['list_paragraph']);
		expect(keys('- First\n- Second\n\n    Continued with @sibling.')).toEqual(['sibling']);
		expect(keys('Paragraph line\n    Continued with @paragraph_citation.')).toEqual(['paragraph_citation']);
		expect(keys('Before\n\n    @indented-code')).toEqual([]);
		expect(keys('>     @blockquote-code')).toEqual([]);
		expect(keys('prose\n>     @blockquote-code')).toEqual([]);
		expect(keys('  ```md\n@fenced\n  ```\n@live')).toEqual(['live']);
		expect(keys('- ```md\n  @fenced-list\n  ```\n@live')).toEqual(['live']);
		expect(keys('- - ```md\n    @nested-list\n    ```\n@live')).toEqual(['live']);
		expect(keys('> ```md\n> @blockquote\n> ```\n@live')).toEqual(['live']);
	});

	test('does not count wildcard outside nocite or bare suppression', () => {
		expect(keys('Text @* and -@notNarrative.')).toEqual([]);
		expect(hasBibliographyDemand('Text @* and -@notNarrative.')).toBe(false);
	});

	test('resolves symbols and completion contexts in every semantic form', () => {
		const text = "---\nnocite: '[@alpha; @beta]'\n---\nSee @gamma and [-@delta].";
		for (const key of ['alpha', 'beta', 'gamma', 'delta']) {
			const at = text.indexOf('@' + key);
			expect(findCitationAtOffset(text, at)?.key).toBe(key);
			expect(findCitationAtOffset(text, at + key.length + 1)?.key).toBe(key);
		}
		expect(getCitationCompletionContextAtOffset('[@alpha; see @be]', 16)).toBeUndefined();
		expect(getCitationCompletionContextAtOffset('See @gam', 8)).toEqual({
			prefix: 'gam', replaceStart: 5, atOffset: 4, form: 'bare',
		});
		const nocite = "---\nnocite: '@alp'\n---\n";
		expect(getCitationCompletionContextAtOffset(nocite, nocite.indexOf("'\n"))).toMatchObject({
			prefix: 'alp', form: 'nocite',
		});
	});

	test('scans malformed CriticMarkup in linear time', () => {
		const text = '{>>text '.repeat(20_000) + '@live';
		const started = performance.now();
		expect(keys(text)).toEqual(['live']);
		expect(performance.now() - started).toBeLessThan(1500);
	});

	test('scans repeated malformed inline-link candidates in linear time', () => {
		for (const fragment of ['[](', '[]("', '[](<']) {
			const text = fragment.repeat(50_000) + ' @live';
			const started = performance.now();
			expect(keys(text)).toEqual(['live']);
			expect(performance.now() - started).toBeLessThan(2000);
		}
		for (const distantSpecial of ['"', '<']) {
			const text = ('[]((').repeat(50_000) + distantSpecial + ' @live';
			const started = performance.now();
			expect(keys(text)).toEqual(['live']);
			expect(performance.now() - started).toBeLessThan(2000);
		}
		for (const matchedSpecial of ['"', '<']) {
			const text = '[]('.repeat(50_000) + matchedSpecial + ')'.repeat(50_000) + ' @live';
			const started = performance.now();
			expect(keys(text)).toEqual(['live']);
			expect(performance.now() - started).toBeLessThan(2000);
		}
		for (const title of ['"title"', "'title'"]) {
			const text = ('[]((').repeat(50_000) + ' ' + title + ' @live';
			const started = performance.now();
			expect(keys(text)).toEqual(['live']);
			expect(performance.now() - started).toBeLessThan(2000);
		}
	});

	test('returns exact UTF-16 source offsets', () => {
		const text = '😀 prose @alpha';
		const usage = scanCitationDocument(text).usages[0];
		expect(usage.atStart).toBe(text.indexOf('@alpha'));
		expect(text.slice(usage.keyStart, usage.keyEnd)).toBe('alpha');
	});

	test('all generated usages obey the offset invariant', () => {
		const keyGen = fc.string({
			unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_:-'.split('')),
			minLength: 1,
			maxLength: 20,
		});
		const partGen = fc.oneof(
			keyGen.map(key => '[@' + key + ']'),
			keyGen.map(key => 'prose @' + key),
			keyGen.map(key => '`@' + key + '`'),
			fc.string({ maxLength: 40 }),
		);
		fc.assert(fc.property(fc.array(partGen, { minLength: 1, maxLength: 12 }), parts => {
			const text = parts.join(' ');
			for (const usage of scanCitationDocument(text).usages) {
				expect(usage.keyStart).toBe(usage.atStart + 1);
				expect(text[usage.atStart]).toBe('@');
				expect(text.slice(usage.keyStart, usage.keyEnd)).toBe(usage.key);
			}
		}), { numRuns: 200 });
	});
});
