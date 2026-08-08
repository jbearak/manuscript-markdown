import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
	analyzeCitationDocument,
	findCitationAtOffset,
	getBoundedCitationCompletionContextAtOffset,
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

	test('uses only closed frontmatter as a whole-document citation exclusion', () => {
		const yaml = [
			"title: '@hidden'",
			"nocite: '[@alpha; @*]'",
			'other: @also-hidden',
		].join('\n');
		const closed = scanCitationDocument('---\n' + yaml + '\n---');
		expect(closed.usages.map(usage => usage.key)).toEqual(['alpha']);
		expect(closed.hasNociteWildcard).toBe(true);

		const unclosed = scanCitationDocument('---\n' + yaml);
		expect(unclosed.usages.map(usage => usage.key)).toEqual(['hidden', 'alpha', 'also-hidden']);
		expect(unclosed.hasNociteWildcard).toBe(false);
	});

	test('handles unclosed frontmatter completion only at the active YAML cursor', () => {
		for (const suffix of ["'\n---", "'"]) {
			const text = "---\ntitle: '@hidden'\nnocite: '@alp" + suffix;
			expect(getCitationCompletionContextAtOffset(text, text.lastIndexOf("'"))).toMatchObject({
				prefix: 'alp', form: 'nocite',
			});
			expect(getCitationCompletionContextAtOffset(text, text.indexOf("'", text.indexOf('title')))).toBeUndefined();
		}
		const wildcard = "---\nnocite: '@";
		expect(getCitationCompletionContextAtOffset(wildcard, wildcard.length)).toMatchObject({
			prefix: '', form: 'nocite',
		});
		const title = "---\ntitle: '@alp";
		expect(getCitationCompletionContextAtOffset(title, title.length)).toBeUndefined();
	});

	test('preserves thematic-break body semantics until a mapping establishes frontmatter', () => {
		const text = '---\nBody prose with @visible';
		expect(keys(text)).toEqual(['visible']);
		expect(getCitationCompletionContextAtOffset(text, text.length)?.form).toBe('bare');
	});

	test('bounds mapping-like prose after a thematic break to its active paragraph', () => {
		const text = '---\nNote: text that resembles metadata.\n\nBody cites @visible.';
		expect(keys(text)).toEqual(['visible']);
		expect(getCitationCompletionContextAtOffset(text, text.indexOf('@visible') + 4)?.form).toBe('bare');
	});

	test('does not hide no-blank-line body prose after an ambiguous mapping-like line', () => {
		for (const text of [
			'---\nNote: text that resembles metadata.\nBody cites @visible.',
			'---\nNote: text that resembles metadata.\nBody cites @visible: details',
		]) {
			expect(keys(text)).toEqual([text.endsWith(': details') ? 'visible:' : 'visible']);
			const offset = text.indexOf('@visible') + '@visible'.length;
			expect(getCitationCompletionContextAtOffset(text, offset)?.form).toBe('bare');
			expect(getBoundedCitationCompletionContextAtOffset(text, offset)?.form).toBe('bare');
		}
	});

	test('keeps provisional nocite completion while scanning later body citations', () => {
		const text = "---\ntitle: Draft\nnocite: '@alpha'\n\nBody cites @beta.";
		expect(keys(text)).toEqual(['alpha', 'beta']);
		expect(getCitationCompletionContextAtOffset(text, text.indexOf("'\n"))?.form).toBe('nocite');
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
			'[target]: https://example.test "unterminated',
			'[target]: https://example.test (nested (title))',
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
		expect(keys('[See @angle](<foo(bar>)')).toEqual(['angle']);
		expect(keys('[See @title](path "title (")')).toEqual(['title']);
		expect(keys('[label](not a valid destination @live)')).toEqual(['live']);
		expect(keys('[see @hidden](not a valid destination) @live')).toEqual(['live']);
		expect(keys('[see @hidden][missing] @live')).toEqual(['live']);
		expect(keys('[see @linked][known] @live\n\n[known]: /url')).toEqual(['linked', 'live']);
		expect(keys('Ordinary punctuation ]( followed by @live')).toEqual(['live']);
	});

	test('does not pair link labels and destinations across Markdown inline blocks', () => {
		for (const [text, key] of [
			['[label\n\n](@paragraph)', 'paragraph'],
			['[label\n# Heading\n](@heading)', 'heading'],
			['[label\n- item\n\n](@list)', 'list'],
			['[label\n```\ncode\n```\n](@fence)', 'fence'],
			['[label\n> quote\n\n](@blockquote)', 'blockquote'],
		]) {
			expect(keys(text)).toEqual([key]);
		}
	});

	test('applies inline exclusions independently inside GFM table cells', () => {
		const text = [
			'| Link | Code | HTML | Ordinary | Citation |',
			'| --- | --- | --- | --- | --- |',
			'| [label](@destination) | `[@code]` | <span data-cite="@attribute">@visible</span> | [note @hidden] | [-@suppressed] |',
		].join('\n');
		expect(scanCitationDocument(text).usages.map(usage => [usage.key, usage.form, usage.suppressAuthor])).toEqual([
			['visible', 'bare', false],
			['suppressed', 'bracket', true],
		]);
		const cursor = text.indexOf('@suppressed') + '@suppressed'.length;
		expect(getCitationCompletionContextAtOffset(text, cursor)?.form).toBe('bracket');

		const crossCell = '| First | Second |\n| --- | --- |\n| [ordinary | @visible] |';
		expect(keys(crossCell)).toEqual(['visible']);
	});

	test('keeps visible raw HTML block text citation-aware while excluding markup', () => {
		const text = [
			'<table data-cite="@table-attribute">',
			'<tr><td>[@first; <!-- @comment --> @second; <span title="@attribute">-@suppressed</span>]</td><td>[@bracket]</td></tr>',
			'</table>',
			'',
			'<div title="@div-attribute">@bare and [label](@destination)</div>',
		].join('\n');
		const analysis = analyzeCitationDocument(text);
		expect(analysis.usages.map(usage => [usage.key, usage.form, usage.suppressAuthor])).toEqual([
			['first', 'bracket', false],
			['second', 'bracket', false],
			['suppressed', 'bracket', true],
			['bracket', 'bracket', false],
			['bare', 'bare', false],
		]);
		for (const usage of analysis.usages) {
			expect(text.slice(usage.atStart, usage.keyEnd)).toBe('@' + usage.key);
			expect(findCitationAtOffset(text, usage.keyEnd, analysis)).toBe(usage);
			expect(getCitationCompletionContextAtOffset(text, usage.keyEnd, analysis)).toMatchObject({
				prefix: usage.key,
				atOffset: usage.atStart,
				form: usage.form,
			});
		}
		expect(keys('<div>[@smith]</div>')).toEqual(['smith']);
	});

	test('does not pair raw HTML delimiters across parser blocks', () => {
		for (const [text, key] of [
			['<div>[ordinary</div>\n\nBody @paragraph]', 'paragraph'],
			['<div>[ordinary</div>\n\n<div>@html]</div>', 'html'],
			['<div>[label</div>\n\n<div>](@destination)</div>', 'destination'],
		]) {
			const usage = scanCitationDocument(text).usages[0];
			expect(usage).toMatchObject({ key, form: 'bare' });
			expect(getCitationCompletionContextAtOffset(text, usage.keyEnd)?.form).toBe('bare');
		}
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

	test('bounds parsed-block analysis independently of document size', () => {
		for (const repetitions of [100, 250_000]) {
			const text = 'ordinary prose\n'.repeat(repetitions) + '@typed';
			const metrics = { windowStart: -1, windowEnd: -1, analyzedLength: -1 };
			expect(getBoundedCitationCompletionContextAtOffset(text, text.length, 64, metrics)?.prefix)
				.toBe('typed');
			expect(metrics).toEqual({
				windowStart: text.length - 64,
				windowEnd: text.length,
				analyzedLength: 64,
			});
		}
	});

	test('restores tiny-window context only when truncation changes the result', () => {
		const backtick = String.fromCharCode(96);
		const cases = [
			{ text: '\\' + backtick + 'x @s' + backtick, boundary: 1, expected: 's' },
			{ text: '\\'.repeat(3) + backtick + ' @s' + backtick, boundary: 1, expected: 's' },
			{ text: '\\'.repeat(4) + backtick + ' @s' + backtick, boundary: 2 },
			{ text: '\\[abc](@s)', boundary: 1, expected: 's' },
			{ text: 'x' + backtick + ' @s' + backtick, boundary: 1 },
			{ text: 'x[label](@s)', boundary: 1 },
			{ text: '\\' + backtick + 'x \\@s' + backtick, boundary: 1 },
			{ text: '\\' + backtick + 'x person@s' + backtick, boundary: 1 },
			{ text: '\\[' + backtick + '@s' + backtick + ']', boundary: 1 },
			{ text: '\\[[label](@s)]', boundary: 1 },
		];
		for (const { text, boundary, expected } of cases) {
			const cursor = text.indexOf('@s') + 2;
			const maxWindow = cursor - boundary;
			expect(maxWindow).toBeLessThan(16);
			expect(getBoundedCitationCompletionContextAtOffset(text, cursor, maxWindow)?.prefix)
				.toBe(expected);
		}
	});

	test('preserves fully local exclusions after a truncated large-document prefix', () => {
		const prefix = 'ordinary prose '.repeat(20);
		for (const suffix of ['\\@s', 'person@s', '`@s`', '[label](@s)']) {
			const text = prefix + suffix;
			const cursor = text.indexOf('@s') + 2;
			expect(getBoundedCitationCompletionContextAtOffset(text, cursor, 64)).toBeUndefined();
		}
	});

	test('does not retry exclusions that are wholly provable inside a tiny window', () => {
		const prefix = 'large prefix '.repeat(10_000);
		for (const suffix of ['\\@s', 'person@s', '`@s`', '[label](@s)']) {
			const text = prefix + suffix;
			const cursor = text.lastIndexOf('@s') + 2;
			const metrics = { windowStart: -1, windowEnd: -1, analyzedLength: -1 };
			expect(getBoundedCitationCompletionContextAtOffset(text, cursor, 16, metrics))
				.toBeUndefined();
			expect(metrics.analyzedLength).toBe(metrics.windowEnd - metrics.windowStart);
		}

		const plain = prefix + 'x'.repeat(20);
		const plainMetrics = { windowStart: -1, windowEnd: -1, analyzedLength: -1 };
		expect(getBoundedCitationCompletionContextAtOffset(plain, plain.length, 16, plainMetrics))
			.toBeUndefined();
		expect(plainMetrics.analyzedLength)
			.toBe(plainMetrics.windowEnd - plainMetrics.windowStart);
	});

	test('restores cut escape runs before code and link delimiters', () => {
		const prefix = 'large prefix '.repeat(10_000);
		const backtick = String.fromCharCode(96);
		const codeSuffix = '\\'.repeat(3) + backtick + 'x'.repeat(58) + ' @s' + backtick;
		const code = prefix + codeSuffix;
		const codeCursor = code.lastIndexOf('@s') + 2;
		const codeMetrics = { windowStart: -1, windowEnd: -1, analyzedLength: -1 };
		expect(getBoundedCitationCompletionContextAtOffset(code, codeCursor, 64, codeMetrics)?.prefix)
			.toBe('s');
		expect(codeMetrics.windowStart).toBe(prefix.length + 1);
		expect(code.slice(codeMetrics.windowStart, codeMetrics.windowStart + 3))
			.toBe('\\'.repeat(2) + backtick);
		expect(codeMetrics.analyzedLength)
			.toBeGreaterThan(codeMetrics.windowEnd - codeMetrics.windowStart);

		const splitBacktickRun = prefix + '``x @s`';
		const splitBacktickCursor = splitBacktickRun.lastIndexOf('@s') + 2;
		const splitBacktickWindow = splitBacktickCursor - prefix.length - 1;
		expect(getBoundedCitationCompletionContextAtOffset(
			splitBacktickRun,
			splitBacktickCursor,
			splitBacktickWindow,
		)?.prefix).toBe('s');

		const escapedBacktickRun = prefix + '\\'.repeat(2) + '``x @s`';
		const escapedBacktickCursor = escapedBacktickRun.lastIndexOf('@s') + 2;
		for (const maxWindow of [5, 7]) {
			expect(getBoundedCitationCompletionContextAtOffset(
				escapedBacktickRun,
				escapedBacktickCursor,
				maxWindow,
			)?.prefix).toBe('s');
		}

		const splitBracketOpener = prefix + '[-@s]';
		const splitBracketCursor = splitBracketOpener.lastIndexOf('@s') + 2;
		expect(getBoundedCitationCompletionContextAtOffset(
			splitBracketOpener,
			splitBracketCursor,
			3,
		)?.form).toBe('bracket');

		const splitEscapedBracketOpener = prefix + '\\'.repeat(2) + '[-@s]';
		const splitEscapedBracketCursor = splitEscapedBracketOpener.lastIndexOf('@s') + 2;
		expect(getBoundedCitationCompletionContextAtOffset(
			splitEscapedBracketOpener,
			splitEscapedBracketCursor,
			5,
		)?.form).toBe('bracket');

		for (const slashCount of [1, 3]) {
			const suffix = '\\'.repeat(slashCount) + '[label](@s)';
			const text = prefix + suffix;
			const cursor = text.lastIndexOf('@s') + 2;
			const maxWindow = cursor - prefix.length - 1;
			const metrics = { windowStart: -1, windowEnd: -1, analyzedLength: -1 };
			expect(getBoundedCitationCompletionContextAtOffset(text, cursor, maxWindow, metrics)?.prefix)
				.toBe('s');
			expect(metrics.windowStart).toBe(prefix.length + 1);
			expect(metrics.analyzedLength).toBeGreaterThan(metrics.windowEnd - metrics.windowStart);
		}

		const unresolvedRun = prefix + '\\'.repeat(7) + '[x](@s)';
		const unresolvedCursor = unresolvedRun.lastIndexOf('@s') + 2;
		const unresolvedMetrics = { windowStart: -1, windowEnd: -1, analyzedLength: -1 };
		expect(getBoundedCitationCompletionContextAtOffset(
			unresolvedRun,
			unresolvedCursor,
			6,
			unresolvedMetrics,
		)?.prefix).toBe('s');
		expect(unresolvedMetrics.analyzedLength)
			.toBeGreaterThan(unresolvedMetrics.windowEnd - unresolvedMetrics.windowStart);
		expect(unresolvedMetrics.analyzedLength).toBeLessThanOrEqual(8 * 6 + 1);
	});

	test('does not retry boundary delimiters when restored escape parity is unchanged', () => {
		const prefix = 'large prefix '.repeat(10_000);
		const backtick = String.fromCharCode(96);
		const structures = [
			backtick + 'x'.repeat(58) + ' @s' + backtick,
			'[label](@s)',
		];
		for (const predecessor of ['x', '\\'.repeat(2)]) {
			for (const structure of structures) {
				const text = prefix + predecessor + structure;
				const cursor = text.lastIndexOf('@s') + 2;
				const maxWindow = cursor - prefix.length - predecessor.length;
				const metrics = { windowStart: -1, windowEnd: -1, analyzedLength: -1 };
				expect(getBoundedCitationCompletionContextAtOffset(text, cursor, maxWindow, metrics))
					.toBeUndefined();
				expect(metrics.windowStart).toBe(prefix.length + predecessor.length);
				expect(metrics.analyzedLength).toBe(metrics.windowEnd - metrics.windowStart);
			}
		}
	});

	test('keeps restored-context analysis bounded independently of document size', () => {
		const backtick = String.fromCharCode(96);
		const analyzedLengths: number[] = [];
		for (const repetitions of [100, 250_000]) {
			const prefix = 'ordinary prose\n'.repeat(repetitions);
			const text = prefix + '\\' + backtick + 'x'.repeat(60) + ' @s' + backtick;
			const cursor = text.indexOf('@s') + 2;
			const metrics = { windowStart: -1, windowEnd: -1, analyzedLength: -1 };
			expect(getBoundedCitationCompletionContextAtOffset(text, cursor, 64, metrics)?.prefix)
				.toBe('s');
			expect(metrics.analyzedLength).toBeLessThanOrEqual(64 * 5 + 1);
			analyzedLengths.push(metrics.analyzedLength);
		}
		expect(new Set(analyzedLengths).size).toBe(1);
	});

	test('allows conservative bounded triggers while full analysis stays authoritative', () => {
		const distantSuffix = '\n' + 'plain text\n'.repeat(20);
		const cases = [
			'`open\n' + 'plain text\n'.repeat(20) + '@hidden`',
			'[ordinary\n' + 'plain text\n'.repeat(20) + '@hidden]',
			'`open\n@hidden' + distantSuffix + '`',
			'[ordinary\n@hidden' + distantSuffix + ']',
			'<span title="@hidden' + distantSuffix + '">visible</span>',
			'```\n\n' + 'plain text\n'.repeat(20) + '@hidden\n```',
		];
		for (const text of cases) {
			const cursor = text.indexOf('@hidden') + '@hidden'.length;
			expect(getBoundedCitationCompletionContextAtOffset(text, cursor, 32)).toBeDefined();
			expect(getCitationCompletionContextAtOffset(text, cursor)).toBeUndefined();
		}

		const plain = 'plain text\n'.repeat(20) + '@visible';
		expect(getBoundedCitationCompletionContextAtOffset(plain, plain.length, 32)?.form).toBe('bare');
		expect(getCitationCompletionContextAtOffset(plain, plain.length)?.form).toBe('bare');
	});

	test('analyzes a large plain document without delimiter-index blowups', () => {
		const text = 'plain prose '.repeat(700_000) + '@needle';
		const analysis = analyzeCitationDocument(text);
		expect(analysis.usages).toEqual([{
			key: 'needle',
			atStart: text.length - 7,
			keyStart: text.length - 6,
			keyEnd: text.length,
			form: 'bare',
			suppressAuthor: false,
		}]);
	});

	test('keeps sparse HTML and link analysis on large mostly plain blocks', () => {
		const plain = 'plain prose '.repeat(350_000);
		const rawHtml = '<div>' + plain + ' @raw</div>';
		const linked = plain + '[label](https://example.test) @linked';
		expect(analyzeCitationDocument(rawHtml).usages.map(usage => usage.key)).toEqual(['raw']);
		expect(analyzeCitationDocument(linked).usages.map(usage => usage.key)).toEqual(['linked']);
	});

	test('scans malformed CriticMarkup in linear time', () => {
		const text = '{>>text '.repeat(20_000) + '@live';
		const started = performance.now();
		expect(keys(text)).toEqual(['live']);
		expect(performance.now() - started).toBeLessThan(1500);
	});

	test('does not let escaped literal backticks hide citations', () => {
		for (const slashCount of [1, 3]) {
			const text = '\\'.repeat(slashCount) + '`literal @visible`';
			expect(keys(text)).toEqual(['visible']);
		}
		for (const slashCount of [2, 4]) {
			const text = '\\'.repeat(slashCount) + '`@hidden` then @visible';
			expect(keys(text)).toEqual(['visible']);
		}
	});

	test('treats the unescaped suffix of a backtick run as a delimiter', () => {
		expect(keys('\\``@hidden` then @visible')).toEqual(['visible']);
	});

	test('keeps citations hidden when a code-span closer follows a backslash', () => {
		for (const delimiter of ['`', '``']) {
			const text = delimiter + '@hidden\\' + delimiter + ' then @visible';
			expect(keys(text)).toEqual(['visible']);
		}
	});

	test('does not let stray backticks hide citations across paragraph boundaries', () => {
		expect(keys('`a\n\nprose @key\n\nb`')).toEqual(['key']);
		expect(keys('> `a\n>\n> prose @key\n> b`')).toEqual(['key']);
	});

	test('does not pair stray backticks across CommonMark block interruptions', () => {
		for (const interruption of [
			'# Heading',
			'```\nfenced\n```',
			'---',
			'- list item',
			'1. ordered item',
		]) {
			expect(keys('`open\n' + interruption + '\nprose @visible\nclose`')).toEqual(['visible']);
		}
	});

	test('does not pair ordinary citation brackets across Markdown inline blocks', () => {
		for (const [text, key] of [
			['[ordinary opener\n\nBody @paragraph]', 'paragraph'],
			['[ordinary opener\n# Heading\nBody @heading]', 'heading'],
			['[ordinary opener\n- item\n\nBody @list]', 'list'],
			['[ordinary opener\n```\ncode ]\n```\nBody @fence]', 'fence'],
			['[ordinary opener\n> quote\n\nBody @blockquote]', 'blockquote'],
		]) {
			expect(keys(text)).toEqual([key]);
			const cursor = text.indexOf('@' + key) + key.length + 1;
			expect(getCitationCompletionContextAtOffset(text, cursor)?.form).toBe('bare');
		}
	});

	test('preserves nested and multiline citation clusters within one inline block', () => {
		expect(keys('Discussion [nested [@alpha;\n @beta]] continues.')).toEqual(['alpha', 'beta']);
		const unfinished = 'Discussion [nested [@alp';
		expect(getCitationCompletionContextAtOffset(unfinished, unfinished.length)).toMatchObject({
			prefix: 'alp', form: 'bracket',
		});
	});

	test('keeps citations visible across list-contained block interruptions', () => {
		for (const [text, key] of [
			['1. first `open\n2. second @ordered close`', 'ordered'],
			['1. first `open\n2.\n3. third @empty_sibling close`', 'empty_sibling'],
			['- # `open\n  prose @heading close`', 'heading'],
			['- prose `open\n    # Heading\n  after @nested_heading close`', 'nested_heading'],
			['- prose `open\n    ---\n  after @thematic close`', 'thematic'],
			['- prose `open\n    ```\n    fenced\n    ```\n  after @fenced close`', 'fenced'],
			['10. outer\n    - nested\n\n    resumed `open\n    # Heading\n    after @outer_heading close`', 'outer_heading'],
			['10. outer\n    - nested\n\n    resumed `open\n    ***\n    after @outer_thematic close`', 'outer_thematic'],
			['10. outer\n    - nested\n\n    resumed `open\n    ```\n    fenced\n    ```\n    after @outer_fenced close`', 'outer_fenced'],
		]) {
			expect(keys(text)).toEqual([key]);
		}
	});

	test('applies CommonMark list interruption and code-block rules', () => {
		for (const text of [
			'prose `open\n2. still the same paragraph\n3. @hidden close`',
			'prose `open\n1.\nafter @hidden close`',
			'-     @hidden',
			'- prose\n  - - -\n  ~~~\n  @hidden\n  ~~~',
		]) {
			expect(keys(text)).toEqual([]);
		}
		for (const marker of ['01. item', '01) item']) {
			expect(keys('prose `open\n' + marker + '\nafter @visible close`')).toEqual(['visible']);
		}
		for (const block of ['# Heading', '***', '```\n    fenced\n    ```']) {
			const text = '10. outer\n    - nested `open\n    ' + block + '\n    after @visible close`';
			expect(keys(text)).toEqual(['visible']);
		}
	});

	test('does not let unfinished inline HTML comments consume later Markdown blocks', () => {
		for (const [text, expected] of [
			['Intro <!-- unfinished\n\nSee @paragraph.', ['paragraph']],
			['Intro <!-- unfinished\n# Heading @heading --> and @after.', ['heading', 'after']],
			['Intro <!-- unfinished\n- item @list --> and @after.', ['list', 'after']],
			['Intro <!-- unfinished\n```md\n@fenced\n```\nBody @after -->', ['after']],
		]) {
			const usages = scanCitationDocument(text).usages;
			expect(usages.map(usage => usage.key)).toEqual(expected);
			for (const usage of usages) {
				expect(getCitationCompletionContextAtOffset(text, usage.keyEnd)?.form).toBe('bare');
			}
		}
		expect(keys('<!-- unfinished\n\n@hidden')).toEqual([]);
		expect(keys('<div><!-- unfinished\n\nBody @visible')).toEqual(['visible']);
	});

	test('bounds unfinished HTML comment searches to their parser blocks', () => {
		const blockCount = 40_000;
		const documents = [
			('Block <!-- unfinished\n\n').repeat(blockCount) + '@visible',
			'plain block\n\n'.repeat(blockCount) + 'Final <!-- unfinished @visible',
		];
		const started = performance.now();
		for (const text of documents) {
			expect(analyzeCitationDocument(text).usages.map(usage => usage.key)).toEqual(['visible']);
		}
		expect(performance.now() - started).toBeLessThan(3000);
	});

	test('ends unfinished HTML tags at blank blockquote container lines', () => {
		for (const blank of ['>', '> ']) {
			expect(keys('> <span title="unfinished\n' + blank + '\n> prose @simple">')).toEqual(['simple']);
		}
		expect(keys('> > <span title="unfinished\n> >\n> > prose @nested">')).toEqual(['nested']);
		expect(keys('> <span title="unfinished\n> \n> prose @inside">')).toEqual([]);
	});

	test('does not let unfinished HTML inline tags consume later Markdown blocks', () => {
		for (const [text, key] of [
			['<span title="unfinished\n\nBody @paragraph">', 'paragraph'],
			['<span title="unfinished\n# Heading @heading">', 'heading'],
			['<span title="unfinished\n- item @list">', 'list'],
			['<span title="unfinished\n```\n@hidden\n```\nBody @fence">', 'fence'],
			['<span title="unfinished\n> quote @blockquote">', 'blockquote'],
		]) {
			expect(keys(text)).toEqual([key]);
		}
	});

	test('scans malformed quoted HTML tag candidates in linear time', () => {
		const text = '<a"'.repeat(50_000) + '>\n\n<span data-cite="@hidden">@live</span>';
		const started = performance.now();
		expect(keys(text)).toEqual(['live']);
		expect(performance.now() - started).toBeLessThan(2000);

		const paragraphSeparated = '<a "\n\n'.repeat(30_000) + '> @live';
		const paragraphStarted = performance.now();
		expect(keys(paragraphSeparated)).toEqual(['live']);
		expect(performance.now() - paragraphStarted).toBeLessThan(2000);
	});

	test('finds valid HTML tags nested inside malformed candidates', () => {
		expect(keys("<a '<span data-cite=@hidden>text</span> @visible")).toEqual(['visible']);
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

	test('scans one large citation cluster in linear time', () => {
		const itemCount = 20_000;
		const text = '[' + Array.from({ length: itemCount }, () => '@alpha').join('; ') + ']';
		const started = performance.now();
		expect(scanCitationDocument(text).usages).toHaveLength(itemCount);
		expect(performance.now() - started).toBeLessThan(2000);
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
