import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	buildBibFieldLink,
	canonicalizeFsPath,
	fileEntryDisplayName,
	findBibFieldLinkAtLine,
	findBibFileFieldAtLine,
	findBibKeyAtOffset,
	findCitekeyAtOffset,
	formatFileEntryMarkdown,
	fsPathToUri,
	getAccessLinksForEntry,
	getCompletionContextAtOffset,
	getFileEntriesForEntry,
	getRevealLabel,
	isInsideCitationSegmentAtOffset,
	parseFileFieldValue,
	parseBibDataFromText,
	pathsEqual,
	resolveFileEntryPath,
	resolveBibliographyPath,
	scanCitationUsages,
} from './citekey-language';
import type { BibtexEntry } from '../bibtex-parser';

describe('scanCitationUsages', () => {
	test('extracts citekeys from grouped citations with locators', () => {
		const text = 'See [@smith2020, p. 12; @jones2019] for details.';
		const usages = scanCitationUsages(text);
		expect(usages.map((u) => u.key)).toEqual(['smith2020', 'jones2019']);
	});

	test('returns unique offsets for the same key cited in separate brackets', () => {
		const text = 'See [@smith2020] and later [@smith2020].';
		const usages = scanCitationUsages(text);
		expect(usages.map((u) => u.key)).toEqual(['smith2020', 'smith2020']);
		// Offsets must differ – each usage is a distinct location
		const offsets = usages.map((u) => u.keyStart);
		expect(new Set(offsets).size).toBe(offsets.length);
	});

	test('does not produce duplicates within a single bracket group', () => {
		const text = 'Reference [@smith2020; @jones2019].';
		const usages = scanCitationUsages(text);
		expect(usages).toHaveLength(2);
		expect(usages.map((u) => u.key)).toEqual(['smith2020', 'jones2019']);
	});

	test('handles same key repeated with locator variants', () => {
		const text = '[@smith2020, p. 1] and [@smith2020, ch. 3] and [@smith2020].';
		const usages = scanCitationUsages(text);
		expect(usages.map((u) => u.key)).toEqual(['smith2020', 'smith2020', 'smith2020']);
		const offsets = usages.map((u) => u.keyStart);
		expect(new Set(offsets).size).toBe(3);
	});

	test('shares bare and nocite recognition with all LSP consumers', () => {
		const text = "---\nnocite: '[@uncited]'\n---\nSee @narrative and [-@suppressed].";
		expect(scanCitationUsages(text).map((u) => u.key)).toEqual(['uncited', 'narrative', 'suppressed']);
		expect(findCitekeyAtOffset(text, text.indexOf('@uncited'))).toBe('uncited');
		expect(findCitekeyAtOffset(text, text.indexOf('@narrative'))).toBe('narrative');
	});

	test('recognizes quoted nocite mapping keys', () => {
		for (const key of ['"nocite"', "'nocite'", '"no\\u0063ite"']) {
			const text = '---\n' + key + ': @alpha\n---\n';
			expect(scanCitationUsages(text).map(usage => usage.key)).toEqual(['alpha']);
			expect(findCitekeyAtOffset(text, text.indexOf('@alpha'))).toBe('alpha');
			expect(
				getCompletionContextAtOffset(text, text.indexOf('@alpha') + 4)?.form,
			).toBe('nocite');
		}
	});

	test('keeps escaped suppress-author boundaries aligned', () => {
		for (let slashCount = 0; slashCount <= 4; slashCount++) {
			const marker = '\\'.repeat(slashCount) + '-@alpha';
			const active = '---\nnocite: ' + marker + '\n---\n';
			expect(scanCitationUsages(active).map(usage => usage.key)).toEqual(['alpha']);
			expect(
				getCompletionContextAtOffset(active, active.indexOf('@alpha') + 6)?.form,
			).toBe('nocite');

			const attached = '---\nnocite: x' + marker + '\n---\n';
			expect(scanCitationUsages(attached)).toEqual([]);
			expect(
				getCompletionContextAtOffset(attached, attached.indexOf('@alpha') + 6),
			).toBeUndefined();
		}
	});

	test('preserves multiline nocite quote and escape state', () => {
		const text = [
			'---',
			'nocite:',
			'  - "note',
			'    \\\\@hidden"',
			'  - @active',
			'---',
		].join('\n');
		expect(scanCitationUsages(text).map(usage => usage.key)).toEqual(['active']);
		expect(findCitekeyAtOffset(text, text.indexOf('@hidden'))).toBeUndefined();
		expect(findCitekeyAtOffset(text, text.indexOf('@active'))).toBe('active');
	});

	test('excludes Markdown image alt labels from LSP citation usages', () => {
		const text = '![@image](figure.png) ![see [@nested]](nested.png) and @body';
		expect(scanCitationUsages(text).map(usage => usage.key)).toEqual(['body']);
		expect(findCitekeyAtOffset(text, text.indexOf('@image'))).toBeUndefined();
		expect(findCitekeyAtOffset(text, text.indexOf('@nested'))).toBeUndefined();
		expect(findCitekeyAtOffset(text, text.indexOf('@body'))).toBe('body');
	});

	test('does not use provisional frontmatter to hide document-wide symbol usages', () => {
		const text = "---\ntitle: '@title_text'\nnocite: '[@uncited; @*]'\nBody cites @body";
		expect(scanCitationUsages(text).map((usage) => usage.key)).toEqual(['title_text', 'uncited', 'body']);
		expect(findCitekeyAtOffset(text, text.indexOf('@title_text'))).toBe('title_text');
		expect(findCitekeyAtOffset(text, text.indexOf('@uncited'))).toBe('uncited');
		expect(findCitekeyAtOffset(text, text.indexOf('@body'))).toBe('body');
	});
});

describe('path canonicalization', () => {
	test('pathsEqual treats symlink and real path as equal', () => {
		if (process.platform === 'win32') {
			return;
		}
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-lsp-paths-'));
		try {
			const realDir = path.join(tmpDir, 'real');
			const aliasDir = path.join(tmpDir, 'alias');
			fs.mkdirSync(realDir, { recursive: true });
			fs.symlinkSync(realDir, aliasDir, 'dir');
			const realBib = path.join(realDir, 'paper.bib');
			const aliasBib = path.join(aliasDir, 'paper.bib');
			fs.writeFileSync(realBib, '@article{smith2020, title={A}}');

			expect(pathsEqual(realBib, aliasBib)).toBe(true);
			expect(canonicalizeFsPath(realBib)).toBe(canonicalizeFsPath(aliasBib));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe('findCitekeyAtOffset', () => {
	test('finds key when cursor is on @ or key characters', () => {
		const text = 'See [@smith2020] and [@jones2019].';
		const atOffset = text.indexOf('@smith2020');
		const keyOffset = atOffset + 4;
		expect(findCitekeyAtOffset(text, atOffset)).toBe('smith2020');
		expect(findCitekeyAtOffset(text, keyOffset)).toBe('smith2020');
	});
});

describe('getCompletionContextAtOffset', () => {
	test('returns completion context inside citation lists', () => {
		const text = 'Text [@smi]';
		const offset = text.indexOf(']'); // cursor after "smi"
		const ctx = getCompletionContextAtOffset(text, offset);
		expect(ctx).toBeDefined();
		expect(ctx?.prefix).toBe('smi');
	});

	test('returns completion context when citation bracket is not closed yet', () => {
		const text = 'Text [@smi';
		const offset = text.length;
		const ctx = getCompletionContextAtOffset(text, offset);
		expect(ctx).toBeDefined();
		expect(ctx?.prefix).toBe('smi');
	});

	test('returns completion context for bare citation after space', () => {
		const text = 'see @smi';
		const offset = text.length;
		const ctx = getCompletionContextAtOffset(text, offset);
		expect(ctx).toBeDefined();
		expect(ctx?.prefix).toBe('smi');
	});

	test('ignores a colon after a body citation in provisional frontmatter', () => {
		const text = '---\nNote: prose\nBody cites @smi: details';
		const offset = text.indexOf('@smi') + '@smi'.length;
		const ctx = getCompletionContextAtOffset(text, offset);
		expect(ctx?.form).toBe('bare');
		expect(ctx?.prefix).toBe('smi');
	});

	test('treats a citation after an unmatched ordinary bracket as bare', () => {
		const text = 'see [ordinary @smi';
		const ctx = getCompletionContextAtOffset(text, text.length);
		expect(ctx?.form).toBe('bare');
		expect(ctx?.prefix).toBe('smi');
	});

	test('suppresses completion inside a balanced ordinary bracket', () => {
		const text = 'see [ordinary @smi]';
		expect(getCompletionContextAtOffset(text, text.indexOf(']'))).toBeUndefined();
	});

	test('suppresses completion inside Markdown image alt labels', () => {
		for (const text of [
			'![@smi](figure.png)',
			'![see [@smi]](figure.png)',
		]) {
			expect(getCompletionContextAtOffset(text, text.indexOf(']'))).toBeUndefined();
		}
	});

	test('keeps bracket completion for unfinished author-suppressed citations', () => {
		const text = 'see [-@smi';
		const ctx = getCompletionContextAtOffset(text, text.length);
		expect(ctx?.form).toBe('bracket');
		expect(ctx?.prefix).toBe('smi');
	});

	test('returns completion context in closed and provisional nocite values only', () => {
		for (const scalar of [
			"---\nnocite: '@smi'\n---\n",
			"---\ntitle: Draft\nnocite: '@smi'",
		]) {
			expect(getCompletionContextAtOffset(scalar, scalar.lastIndexOf("'"))?.form).toBe('nocite');
		}
		const block = '---\nnocite: |\n  @smi\n---\n';
		expect(getCompletionContextAtOffset(block, block.indexOf('\n---'))?.form).toBe('nocite');
		for (const other of [
			"---\ntitle: '@smi'\n---\n",
			"---\ntitle: '@smi'",
		]) {
			expect(getCompletionContextAtOffset(other, other.lastIndexOf("'"))).toBeUndefined();
		}
	});

	test('does not return completion context for NFC or NFD email addresses', () => {
		for (const text of ['user@domain', 'café@domain', 'café@domain']) {
			expect(getCompletionContextAtOffset(text, text.length)).toBeUndefined();
		}
	});

	test('does not return completion context when a letter or mark directly precedes @', () => {
		for (const text of ['first-last@domain', 'é@domain', 'é@domain']) {
			expect(getCompletionContextAtOffset(text, text.length)).toBeUndefined();
		}
	});

	test('does not return completion context when hyphen directly precedes @', () => {
		expect(getCompletionContextAtOffset('-@key', 5)).toBeUndefined();
	});

	test('returns completion context for unclosed bracket when ] exists on later line', () => {
		const text = 'See [@smi\nOther text [@key2]';
		const offset = text.indexOf('\n'); // end of first line
		const ctx = getCompletionContextAtOffset(text, offset);
		expect(ctx).toBeDefined();
		expect(ctx?.prefix).toBe('smi');
	});

	test('returns completion context just before semicolon delimiter in citation list', () => {
		const text = 'Text [@smith2020; @jones2019]';
		const semicolonOffset = text.indexOf(';');
		const ctx = getCompletionContextAtOffset(text, semicolonOffset);
		expect(ctx).toBeDefined();
		expect(ctx?.prefix).toBe('smith2020');
	});

	test('returns undefined immediately after semicolon delimiter in citation list', () => {
		const text = 'Text [@smith2020; @jones2019]';
		const semicolonOffset = text.indexOf(';');
		const ctx = getCompletionContextAtOffset(text, semicolonOffset + 1);
		expect(ctx).toBeUndefined();
	});
});
describe('isInsideCitationSegmentAtOffset', () => {
	test('returns true for semicolon delimiter in grouped citation', () => {
		const text = 'Text [@smith2020; @jones2019]';
		const semicolonOffset = text.indexOf(';');
		expect(isInsideCitationSegmentAtOffset(text, semicolonOffset)).toBe(true);
	});
	test('returns true for semicolon delimiter after locator text', () => {
		const text = 'Text [@smith2020, p. 12; @jones2019]';
		const semicolonOffset = text.indexOf(';');
		expect(isInsideCitationSegmentAtOffset(text, semicolonOffset)).toBe(true);
	});
	test('returns false inside nested Markdown image alt labels', () => {
		const text = '![see [@smith2020; @jones2019]](figure.png)';
		expect(isInsideCitationSegmentAtOffset(text, text.indexOf(';'))).toBe(false);
	});
});

describe('resolveBibliographyPath', () => {
	test('resolves frontmatter bibliography path and normalizes .bib extension', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-lsp-bib-'));
		try {
			const markdownPath = path.join(tmpDir, 'paper.md');
			const bibPath = path.join(tmpDir, 'refs', 'library.bib');
			fs.mkdirSync(path.dirname(bibPath), { recursive: true });
			fs.writeFileSync(
				markdownPath,
				'---\n' +
					'bibliography: refs/library\n' +
					'---\n\n' +
					'Body [@smith2020].\n'
			);
			fs.writeFileSync(bibPath, '@article{smith2020,\n  title={A}\n}\n');
			const markdownText = fs.readFileSync(markdownPath, 'utf8');
			const resolved = resolveBibliographyPath(fsPathToUri(markdownPath), markdownText, [tmpDir]);
			expect(resolved).toBe(bibPath);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('falls back to same-base .bib when frontmatter is absent', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-lsp-fallback-'));
		try {
			const markdownPath = path.join(tmpDir, 'draft.md');
			const bibPath = path.join(tmpDir, 'draft.bib');
			fs.writeFileSync(markdownPath, 'Body [@smith2020].\n');
			fs.writeFileSync(bibPath, '@article{smith2020,\n  title={A}\n}\n');
			const markdownText = fs.readFileSync(markdownPath, 'utf8');
			const resolved = resolveBibliographyPath(fsPathToUri(markdownPath), markdownText, [tmpDir]);
			expect(resolved).toBe(bibPath);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe('parseBibDataFromText / findBibKeyAtOffset', () => {
	test('maps citation keys to declaration offsets in BibTeX', () => {
		const text =
			'@article{smith2020,\n  title = {One},\n}\n\n' +
			'@book{jones2019,\n  title = {Two},\n}\n';
		const parsed = parseBibDataFromText('/tmp/test.bib', text);
		expect(parsed.entries.has('smith2020')).toBe(true);
		expect(parsed.entries.has('jones2019')).toBe(true);

		const smithOffset = parsed.keyOffsets.get('smith2020');
		expect(smithOffset).toBeDefined();
		expect(findBibKeyAtOffset(parsed, (smithOffset ?? 0) + 2)).toBe('smith2020');
	});

	test('maps key offset after opening brace when key appears in entry type', () => {
		const text = '@book{book,\n  title = {One},\n}\n';
		const parsed = parseBibDataFromText('/tmp/test.bib', text);
		expect(parsed.keyOffsets.get('book')).toBe(text.indexOf('{book') + 1);
	});
});


describe('findBibFieldLinkAtLine', () => {
	test('detects DOI with brace delimiters', () => {
		const result = findBibFieldLinkAtLine('  doi = {10.1234/test},');
		expect(result).toBeDefined();
		expect(result!.fieldName).toBe('doi');
		expect(result!.value).toBe('10.1234/test');
		expect(result!.url).toBe('https://doi.org/10.1234/test');
		expect(result!.label).toBe('Access via DOI');
	});

	test('detects DOI with quote delimiters', () => {
		const result = findBibFieldLinkAtLine('  doi = "10.1234/test",');
		expect(result).toBeDefined();
		expect(result!.url).toBe('https://doi.org/10.1234/test');
	});

	test('detects ISBN with brace delimiters', () => {
		const result = findBibFieldLinkAtLine('  isbn = {978-0-306-40615-7},');
		expect(result).toBeDefined();
		expect(result!.fieldName).toBe('isbn');
		expect(result!.value).toBe('978-0-306-40615-7');
		expect(result!.url).toBe('https://search.worldcat.org/isbn/978-0-306-40615-7');
		expect(result!.label).toBe('Look up ISBN');
	});

	test('detects ISSN with brace delimiters', () => {
		const result = findBibFieldLinkAtLine('  issn = {0028-0836},');
		expect(result).toBeDefined();
		expect(result!.fieldName).toBe('issn');
		expect(result!.value).toBe('0028-0836');
		expect(result!.url).toBe('https://portal.issn.org/resource/ISSN/0028-0836');
		expect(result!.label).toBe('Look up ISSN');
	});

	test('is case-insensitive for field name', () => {
		const result = findBibFieldLinkAtLine('  DOI = {10.1234/test},');
		expect(result).toBeDefined();
		expect(result!.fieldName).toBe('doi');
	});

	test('returns undefined for empty value', () => {
		expect(findBibFieldLinkAtLine('  doi = {},')).toBeUndefined();
	});

	test('returns undefined for non-link fields', () => {
		expect(findBibFieldLinkAtLine('  title = {Some Title},')).toBeUndefined();
		expect(findBibFieldLinkAtLine('  author = {Smith, John},')).toBeUndefined();
	});

	test('returns undefined for entry header lines', () => {
		expect(findBibFieldLinkAtLine('@article{smith2020,')).toBeUndefined();
	});

	test('returns invalid for malformed DOI', () => {
		const result = findBibFieldLinkAtLine('  doi = {not-a-doi},');
		expect(result).toBeDefined();
		expect(result!.invalid).toBe(true);
		expect(result!.url).toBeUndefined();
		expect(result!.label).toContain('Invalid DOI');
	});

	test('accepts DOI with parentheses and percent-encodes them in URL', () => {
		const result = findBibFieldLinkAtLine('  doi = {10.1002/(SICI)1097-0258},');
		expect(result).toBeDefined();
		expect(result!.invalid).toBeUndefined();
		expect(result!.url).toBe('https://doi.org/10.1002/%28SICI%291097-0258');
	});

	test('returns invalid for malformed ISBN', () => {
		const result = findBibFieldLinkAtLine('  isbn = {abc-not-isbn},');
		expect(result).toBeDefined();
		expect(result!.invalid).toBe(true);
		expect(result!.url).toBeUndefined();
		expect(result!.label).toContain('Invalid ISBN');
	});

	test('returns invalid for malformed ISSN', () => {
		const result = findBibFieldLinkAtLine('  issn = {not-an-issn},');
		expect(result).toBeDefined();
		expect(result!.invalid).toBe(true);
		expect(result!.url).toBeUndefined();
		expect(result!.label).toContain('Invalid ISSN');
	});

	test('accepts ISSN without hyphen', () => {
		const result = findBibFieldLinkAtLine('  issn = {00280836},');
		expect(result).toBeDefined();
		expect(result!.invalid).toBeUndefined();
		expect(result!.url).toBe('https://portal.issn.org/resource/ISSN/00280836');
	});

	test('accepts unhyphenated ISBN-10 with X check digit', () => {
		const result = findBibFieldLinkAtLine('  isbn = {030640615X},');
		expect(result).toBeDefined();
		expect(result!.invalid).toBeUndefined();
		expect(result!.url).toBe('https://search.worldcat.org/isbn/030640615X');
	});

	test('handles doubly-braced DOI value', () => {
		const result = findBibFieldLinkAtLine('  doi = {{10.1234/test}},');
		expect(result).toBeDefined();
		expect(result!.invalid).toBeUndefined();
		expect(result!.value).toBe('10.1234/test');
		expect(result!.url).toBe('https://doi.org/10.1234/test');
	});

	test('accepts ISBN-10', () => {
		const result = findBibFieldLinkAtLine('  isbn = {0-306-40615-2},');
		expect(result).toBeDefined();
		expect(result!.invalid).toBeUndefined();
		expect(result!.url).toBe('https://search.worldcat.org/isbn/0-306-40615-2');
	});
});

describe('code-region filtering', () => {
	test('scanCitationUsages returns no usages for citation inside inline code', () => {
		const text = 'Some text `[@smith2020]` more text';
		const usages = scanCitationUsages(text);
		expect(usages).toEqual([]);
	});

	test('scanCitationUsages returns usage for citation outside code', () => {
		const text = 'See [@smith2020] for details.';
		const usages = scanCitationUsages(text);
		expect(usages).toHaveLength(1);
		expect(usages[0].key).toBe('smith2020');
	});

	test('scanCitationUsages returns only outside usages when citations are both inside and outside code', () => {
		const text = '`[@inside]` some text [@outside]';
		const usages = scanCitationUsages(text);
		expect(usages).toHaveLength(1);
		expect(usages[0].key).toBe('outside');
	});

	test('scanCitationUsages returns no usages for citation inside fenced code block', () => {
		const text = '```\n[@smith2020]\n```';
		const usages = scanCitationUsages(text);
		expect(usages).toEqual([]);
	});

	test('findCitekeyAtOffset returns undefined for position inside inline code', () => {
		const text = 'Some `@key` here';
		// offset pointing to 'k' in @key inside backticks
		const offset = text.indexOf('@key') + 1;
		expect(findCitekeyAtOffset(text, offset)).toBeUndefined();
	});

	test('findCitekeyAtOffset returns key for position outside code', () => {
		const text = 'See [@key] here';
		const offset = text.indexOf('@key') + 1;
		expect(findCitekeyAtOffset(text, offset)).toBe('key');
	});

	test('scanCitationUsages finds citation when code span contains [ that could anchor greedy match', () => {
		const text = '`[ ` [@a]';
		const usages = scanCitationUsages(text);
		expect(usages).toHaveLength(1);
		expect(usages[0].key).toBe('a');
	});

	test('findCitekeyAtOffset finds citation after code span with bracket', () => {
		const text = '`[ ` [@a]';
		const offset = text.indexOf('@a') + 1;
		expect(findCitekeyAtOffset(text, offset)).toBe('a');
	});
});

function makeEntry(fields: Record<string, string>): BibtexEntry {
	return { type: 'article', key: 'test2020', fields: new Map(Object.entries(fields)) };
}

describe('buildBibFieldLink', () => {
	test('builds DOI link', () => {
		const result = buildBibFieldLink('doi', '10.1234/test');
		expect(result).toBeDefined();
		expect(result!.fieldName).toBe('doi');
		expect(result!.url).toBe('https://doi.org/10.1234/test');
		expect(result!.label).toBe('Access via DOI');
		expect(result!.invalid).toBeUndefined();
	});

	test('builds ISBN link', () => {
		const result = buildBibFieldLink('isbn', '978-0-306-40615-7');
		expect(result).toBeDefined();
		expect(result!.url).toBe('https://search.worldcat.org/isbn/978-0-306-40615-7');
		expect(result!.label).toBe('Look up ISBN');
	});

	test('builds ISSN link', () => {
		const result = buildBibFieldLink('issn', '0028-0836');
		expect(result).toBeDefined();
		expect(result!.url).toBe('https://portal.issn.org/resource/ISSN/0028-0836');
		expect(result!.label).toBe('Look up ISSN');
	});

	test('builds URL link for valid http URL', () => {
		const result = buildBibFieldLink('url', 'https://example.com/paper');
		expect(result).toBeDefined();
		expect(result!.fieldName).toBe('url');
		expect(result!.url).toBe('https://example.com/paper');
		expect(result!.label).toBe('Access via URL');
		expect(result!.invalid).toBeUndefined();
	});

	test('builds URL link for http URL', () => {
		const result = buildBibFieldLink('url', 'http://example.com');
		expect(result).toBeDefined();
		expect(result!.url).toBe('http://example.com');
	});

	test('returns invalid for non-http URL', () => {
		const result = buildBibFieldLink('url', 'ftp://example.com');
		expect(result).toBeDefined();
		expect(result!.invalid).toBe(true);
		expect(result!.label).toContain('Invalid URL');
	});

	test('returns invalid for scheme-only URL with no host', () => {
		const result = buildBibFieldLink('url', 'https://');
		expect(result).toBeDefined();
		expect(result!.invalid).toBe(true);
	});

	test('returns invalid for URL containing whitespace', () => {
		const result = buildBibFieldLink('url', 'https://example.com bad');
		expect(result).toBeDefined();
		expect(result!.invalid).toBe(true);
	});

	test('returns invalid for malformed DOI', () => {
		const result = buildBibFieldLink('doi', 'not-a-doi');
		expect(result).toBeDefined();
		expect(result!.invalid).toBe(true);
	});

	test('returns undefined for unknown field', () => {
		expect(buildBibFieldLink('title', 'Some Title')).toBeUndefined();
	});

	test('returns undefined for empty value', () => {
		expect(buildBibFieldLink('doi', '')).toBeUndefined();
		expect(buildBibFieldLink('doi', '  ')).toBeUndefined();
	});

	test('strips outer braces from value', () => {
		const result = buildBibFieldLink('doi', '{10.1234/test}');
		expect(result).toBeDefined();
		expect(result!.value).toBe('10.1234/test');
	});

	test('is case-insensitive for field name', () => {
		const result = buildBibFieldLink('DOI', '10.1234/test');
		expect(result).toBeDefined();
		expect(result!.fieldName).toBe('doi');
	});
});

describe('getAccessLinksForEntry', () => {
	test('returns empty array when entry has no link fields', () => {
		const entry = makeEntry({ title: 'Some Paper', author: 'Smith' });
		expect(getAccessLinksForEntry(entry)).toEqual([]);
	});

	test('returns single link for entry with DOI only', () => {
		const entry = makeEntry({ doi: '10.1234/test' });
		const links = getAccessLinksForEntry(entry);
		expect(links).toHaveLength(1);
		expect(links[0].fieldName).toBe('doi');
	});

	test('returns multiple links in order: doi, isbn, issn, url', () => {
		const entry = makeEntry({
			url: 'https://example.com',
			issn: '0028-0836',
			doi: '10.1234/test',
		});
		const links = getAccessLinksForEntry(entry);
		expect(links).toHaveLength(3);
		expect(links.map(l => l.fieldName)).toEqual(['doi', 'issn', 'url']);
	});

	test('skips invalid fields', () => {
		const entry = makeEntry({
			doi: 'not-a-doi',
			isbn: '978-0-306-40615-7',
		});
		const links = getAccessLinksForEntry(entry);
		expect(links).toHaveLength(1);
		expect(links[0].fieldName).toBe('isbn');
	});

	test('returns all four link types when present', () => {
		const entry = makeEntry({
			doi: '10.1234/test',
			isbn: '978-0-306-40615-7',
			issn: '0028-0836',
			url: 'https://example.com',
		});
		const links = getAccessLinksForEntry(entry);
		expect(links).toHaveLength(4);
		expect(links.map(l => l.fieldName)).toEqual(['doi', 'isbn', 'issn', 'url']);
	});

	test('requires lowercase field keys (bibtex parser normalizes these)', () => {
		const entry = makeEntry({
			DOI: '10.1234/test',
			ISBN: '978-0-306-40615-7',
			ISSN: '0028-0836',
			URL: 'https://example.com',
		});
		const links = getAccessLinksForEntry(entry);
		expect(links).toHaveLength(0);
	});
});

describe('findBibFieldLinkAtLine — url field', () => {
	test('detects url with brace delimiters', () => {
		const result = findBibFieldLinkAtLine('  url = {https://example.com/paper},');
		expect(result).toBeDefined();
		expect(result!.fieldName).toBe('url');
		expect(result!.url).toBe('https://example.com/paper');
		expect(result!.label).toBe('Access via URL');
	});

	test('detects url with quote delimiters', () => {
		const result = findBibFieldLinkAtLine('  url = "https://example.com/paper",');
		expect(result).toBeDefined();
		expect(result!.url).toBe('https://example.com/paper');
	});

	test('returns invalid for non-http url field', () => {
		const result = findBibFieldLinkAtLine('  url = {ftp://files.example.com},');
		expect(result).toBeDefined();
		expect(result!.invalid).toBe(true);
		expect(result!.label).toContain('Invalid URL');
	});
});

// --- File field tests ---

describe('parseFileFieldValue', () => {
	test('parses single file entry with standard format', () => {
		const entries = parseFileFieldValue('Paper.pdf:/path/to/paper.pdf:PDF');
		expect(entries).toHaveLength(1);
		expect(entries[0].description).toBe('Paper.pdf');
		expect(entries[0].filePath).toBe('/path/to/paper.pdf');
		expect(entries[0].fileType).toBe('PDF');
		expect(entries[0].fileName).toBe('paper.pdf');
	});

	test('parses multiple file entries separated by semicolons', () => {
		const entries = parseFileFieldValue('Paper.pdf:/path/to/paper.pdf:PDF;Supplement:/path/to/supp.pdf:PDF');
		expect(entries).toHaveLength(2);
		expect(entries[0].description).toBe('Paper.pdf');
		expect(entries[0].filePath).toBe('/path/to/paper.pdf');
		expect(entries[1].description).toBe('Supplement');
		expect(entries[1].filePath).toBe('/path/to/supp.pdf');
	});

	test('handles empty description (JabRef format)', () => {
		const entries = parseFileFieldValue(':/path/to/paper.pdf:PDF');
		expect(entries).toHaveLength(1);
		expect(entries[0].description).toBe('');
		expect(entries[0].filePath).toBe('/path/to/paper.pdf');
		expect(entries[0].fileType).toBe('PDF');
	});

	test('handles relative paths', () => {
		const entries = parseFileFieldValue(':paper.pdf:PDF');
		expect(entries).toHaveLength(1);
		expect(entries[0].filePath).toBe('paper.pdf');
		expect(entries[0].fileName).toBe('paper.pdf');
	});

	test('handles paths with spaces', () => {
		const entries = parseFileFieldValue('My Paper:/path/to/my paper.pdf:PDF');
		expect(entries).toHaveLength(1);
		expect(entries[0].filePath).toBe('/path/to/my paper.pdf');
	});

	test('handles escaped colons in paths', () => {
		const entries = parseFileFieldValue(':C\\:/Users/test/paper.pdf:PDF');
		expect(entries).toHaveLength(1);
		expect(entries[0].filePath).toBe('C:/Users/test/paper.pdf');
	});

	test('handles bare Windows drive-letter path without description', () => {
		const entries = parseFileFieldValue('C:/Users/test/paper.pdf:PDF');
		expect(entries).toHaveLength(1);
		expect(entries[0].description).toBe('');
		expect(entries[0].filePath).toBe('C:/Users/test/paper.pdf');
		expect(entries[0].fileType).toBe('PDF');
	});

	test('does not treat multi-char first segment as drive letter', () => {
		const entries = parseFileFieldValue('Paper:/path/to/file.pdf:PDF');
		expect(entries).toHaveLength(1);
		expect(entries[0].description).toBe('Paper');
		expect(entries[0].filePath).toBe('/path/to/file.pdf');
	});

	test('handles escaped semicolons', () => {
		const entries = parseFileFieldValue(':path/to/file\\;v2.pdf:PDF');
		expect(entries).toHaveLength(1);
		expect(entries[0].filePath).toBe('path/to/file;v2.pdf');
	});

	test('returns empty array for empty value', () => {
		expect(parseFileFieldValue('')).toEqual([]);
		expect(parseFileFieldValue('  ')).toEqual([]);
	});

	test('strips outer braces', () => {
		const entries = parseFileFieldValue('{Paper.pdf:/path/to/paper.pdf:PDF}');
		expect(entries).toHaveLength(1);
		expect(entries[0].description).toBe('Paper.pdf');
	});

	test('skips empty segments from trailing semicolons', () => {
		const entries = parseFileFieldValue(':paper.pdf:PDF;');
		expect(entries).toHaveLength(1);
	});

	test('handles two-part format as Path:Type', () => {
		const entries = parseFileFieldValue('paper.pdf:PDF');
		expect(entries).toHaveLength(1);
		expect(entries[0].filePath).toBe('paper.pdf');
		expect(entries[0].fileType).toBe('PDF');
	});

	test('handles single value with no colons', () => {
		const entries = parseFileFieldValue('/path/to/paper.pdf');
		expect(entries).toHaveLength(1);
		expect(entries[0].filePath).toBe('/path/to/paper.pdf');
		expect(entries[0].description).toBe('');
		expect(entries[0].fileType).toBe('');
	});

	test('handles application/pdf file type', () => {
		const entries = parseFileFieldValue('Paper:/path/to/paper.pdf:application/pdf');
		expect(entries).toHaveLength(1);
		expect(entries[0].fileType).toBe('application/pdf');
	});
});

describe('findBibFileFieldAtLine', () => {
	test('detects file field with brace delimiters', () => {
		const result = findBibFileFieldAtLine('  file = {Paper.pdf:/path/to/paper.pdf:PDF},');
		expect(result).toBeDefined();
		expect(result).toHaveLength(1);
		expect(result![0].filePath).toBe('/path/to/paper.pdf');
	});

	test('detects file field with quote delimiters', () => {
		const result = findBibFileFieldAtLine('  file = "Paper.pdf:/path/to/paper.pdf:PDF",');
		expect(result).toBeDefined();
		expect(result).toHaveLength(1);
	});

	test('is case-insensitive for field name', () => {
		const result = findBibFileFieldAtLine('  File = {:/path/to/paper.pdf:PDF},');
		expect(result).toBeDefined();
		expect(result).toHaveLength(1);
	});

	test('returns undefined for empty file field', () => {
		expect(findBibFileFieldAtLine('  file = {},')).toBeUndefined();
	});

	test('returns undefined for non-file fields', () => {
		expect(findBibFileFieldAtLine('  doi = {10.1234/test},')).toBeUndefined();
		expect(findBibFileFieldAtLine('  title = {Some Title},')).toBeUndefined();
	});

	test('returns undefined for citekey lines', () => {
		expect(findBibFileFieldAtLine('@article{smith2020,')).toBeUndefined();
	});

	test('detects multiple files in one field', () => {
		const result = findBibFileFieldAtLine('  file = {Paper:/a.pdf:PDF;Supp:/b.pdf:PDF},');
		expect(result).toBeDefined();
		expect(result).toHaveLength(2);
	});
});

describe('getFileEntriesForEntry', () => {
	test('returns empty array when entry has no file field', () => {
		const entry = makeEntry({ title: 'Some Paper', author: 'Smith' });
		expect(getFileEntriesForEntry(entry)).toEqual([]);
	});

	test('returns file entries for entry with file field', () => {
		const entry = makeEntry({ file: ':/path/to/paper.pdf:PDF' });
		const entries = getFileEntriesForEntry(entry);
		expect(entries).toHaveLength(1);
		expect(entries[0].filePath).toBe('/path/to/paper.pdf');
	});

	test('returns multiple file entries', () => {
		const entry = makeEntry({ file: 'Paper:/a.pdf:PDF;Supplement:/b.pdf:PDF' });
		const entries = getFileEntriesForEntry(entry);
		expect(entries).toHaveLength(2);
	});
});

describe('fileEntryDisplayName', () => {
	test('uses description when provided', () => {
		expect(fileEntryDisplayName({ description: 'Paper', filePath: '/a.pdf', fileType: 'PDF', fileName: 'a.pdf' })).toBe('Paper');
	});

	test('falls back to fileName when no description', () => {
		expect(fileEntryDisplayName({ description: '', filePath: '/path/to/a.pdf', fileType: 'PDF', fileName: 'a.pdf' })).toBe('a.pdf');
	});
});

describe('resolveFileEntryPath', () => {
	const absPath = process.platform === 'win32' ? 'C:\\docs\\path.pdf' : '/absolute/path.pdf';
	const bibDir = process.platform === 'win32' ? 'C:\\home\\user\\refs' : '/home/user/refs';

	test('returns absolute paths unchanged', () => {
		expect(resolveFileEntryPath(absPath, bibDir)).toBe(absPath);
	});

	test('resolves relative paths against bib directory', () => {
		const result = resolveFileEntryPath('paper.pdf', bibDir);
		expect(result).toBe(path.join(bibDir, 'paper.pdf'));
	});

	test('resolves nested relative paths', () => {
		const result = resolveFileEntryPath('files/paper.pdf', bibDir);
		expect(result).toBe(path.join(bibDir, 'files', 'paper.pdf'));
	});
});

describe('formatFileEntryMarkdown', () => {
	test('produces markdown with open and reveal links', () => {
		const md = formatFileEntryMarkdown('paper.pdf', '/path/to/paper.pdf');
		expect(md).toContain('**paper.pdf**');
		expect(md).toContain('[Open file]');
		expect(md).toContain('command:manuscript-markdown.openBibFile');
		expect(md).toContain('command:manuscript-markdown.revealBibFile');
	});

	test('encodes file path in command URI', () => {
		const md = formatFileEntryMarkdown('paper.pdf', '/path/to/paper.pdf');
		const encoded = encodeURIComponent(JSON.stringify(['/path/to/paper.pdf']));
		expect(md).toContain(encoded);
	});

	test('uses platform-appropriate reveal label', () => {
		const md = formatFileEntryMarkdown('paper.pdf', '/path/to/paper.pdf');
		expect(md).toContain(getRevealLabel());
	});

	test('escapes markdown-special characters in display name', () => {
		const md = formatFileEntryMarkdown('review [final].pdf', '/path/to/file.pdf');
		expect(md).toContain('review \\[final\\].pdf');
		expect(md).toContain('[Open file]');
	});
});

