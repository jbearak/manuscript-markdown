import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseMd } from '../md-to-docx';
import { fastestRun } from '../test-timing';
import {
	buildBibFieldLink,
	canonicalizeFsPath,
	fileEntryDisplayName,
	findBibFieldLinkAtLine,
	findBibFileFieldAtLine,
	findBibKeyAtOffset,
	findRepeatedBibFields,
	findCitekeyAtOffset,
	findUncitableBibKeys,
	findUsagesForKey,
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

	test('extracts citekeys from citations with prefixes', () => {
		const text = 'See [e.g., @smith2020; see also @jones2019] for details.';
		const usages = scanCitationUsages(text);
		expect(usages.map((u) => u.key)).toEqual(['smith2020', 'jones2019']);
		expect(text.slice(usages[0].keyStart, usages[0].keyEnd)).toBe('smith2020');
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
});

describe('citation keys as export reads them', () => {
	// Which the LSP read as letters, digits, _, : and -, where export reads a
	// key to its comma (see readCitationItem): so it reported part of a key
	// as missing, or none of one, took an e-mail address's domain for a key,
	// and found a key in a longer one
	test.each([
		['a key with a period', '[@smith.2020]', ['smith.2020']],
		['a key in letters of another language', '[@\u00E9t\u00E92020]', ['\u00E9t\u00E92020']],
		['a key with a slash, after a prefix and before a locator', '[see @a/b, p. 3]', ['a/b']],
		['a key with a space in it, which export reads to its comma', '[@smith 2020]', ['smith 2020']],
		['an e-mail address', '[write to me@example.com]', []],
		// Guard: keys of letters and digits, one with its author suppressed
		['keys of letters and digits', '[@a1; -@b2, p. 3]', ['a1', 'b2']],
	])('reads %s as export does', (_name, text, keys) => {
		expect(scanCitationUsages(text).map(usage => [usage.key, text.slice(usage.keyStart, usage.keyEnd)])).toEqual(keys.map(key => [key, key]));
	});

	// Which read from a segment's first [ to its ], so in `[text [@smith2020]]`
	// it read `text [@smith2020` as the citation, and the @ after a [, not a
	// space, as no key's. A citation starts at the [ export's citationEnd
	// reads it from: the first whose text starts with an @ or a -@, or has no
	// other [ before the ]
	test.each([
		['a citation in brackets, after text', '[text [@smith2020]]', ['smith2020']],
		['a citation two brackets deep', '[t [u [@a; @b]]]', ['a', 'b']],
		['a citation in brackets, after a prefixed one', '[see [see @a]]', ['a']],
		['a citation after an @ in text and a [', '[mail a@b [@c]]', ['c']],
		['a citation after an escaped [', '\\[x [@a]', ['a']],
		// Guards: a [ in a locator, which export reads as text in the item,
		// a [ in a key, and a citation after bracketed text; and brackets over
		// more than one line, whose keys are read as main read them, where
		// export reads the same: a citation over a line end, with CRLF, CR
		// alone, and in a blockquote
		['a [ in a locator', '[@a, see [@b]]', ['a']],
		['a [ in a key', '[@a[b]', ['a[b']],
		['a citation after bracketed text', '[a] [@b]', ['b']],
		['a citation over a line end', '[see\n@a, p.\n3]', ['a']],
		['items on two lines, with CRLF', '[@a;\r\n@b]', ['a', 'b']],
		['items on two lines, with CR', '[@a;\r@b]', ['a', 'b']],
		['a citation in a blockquote, its ] on the next line', '> [@smith2020\n> ]', ['smith2020']],
		['items on two lines of a blockquote in a blockquote', '> > [@a;\n> > @b]', ['a', 'b']],
		// A ;, a [, a ] or an @ a backslash escapes, which ends no item or
		// citation and starts no key, as Pandoc reads it, where the LSP read
		// a citation to the first ], escaped or not
		['an escaped ; in a locator', '[@a, p. 2\\; 5; @b]', ['a', 'b']],
		['an escaped [ and ] in a locator', '[@a, p. 4 \\[n. 2\\]; @b]', ['a', 'b']],
		['an escaped ] a later ] ends the citation after', '[@a, x\\] y; @b]', ['a', 'b']],
		['an escaped [ in a later item\'s prefix', '[@a; see \\[x\\] @b]', ['a', 'b']],
		// Guards: an escaped @ in a prefix, and an escaped ] that ends the
		// citation, as before, with no ] after it, before a [, or after a key
		['an escaped @ in a prefix', '[cf. \\@x @a]', ['a']],
		['an escaped ] with no ] after it', '[@a, x\\] @b', ['a']],
		['an escaped ] before a [', '[@a, x\\] and [@b]', ['a', 'b']],
		['a key that ends with a backslash', '[@a\\] b]', ['a\\']],
	])('reads %s as export does', (_name, text, keys) => {
		expect(scanCitationUsages(text).map(usage => [usage.key, text.slice(usage.keyStart, usage.keyEnd)])).toEqual(keys.map(key => [key, key]));
		const runs = parseMd(text).flatMap(token => token.runs ?? []).filter(item => item.type === 'citation');
		expect(runs.flatMap(item => item.keys ?? [])).toEqual(keys);
	});

	// Brackets over more than one line, whose keys are read as main read
	// them, where export, which reads a block at a time, reads others: no
	// citation across a blank line, and none from an unfinished [@draft
	// across a heading
	test.each([
		['brackets with a blank line between', '[@a\n\nb]', ['a'], []],
		['brackets with a line of spaces between', '[@a\n  \nb]', ['a'], []],
		['brackets with a blank line between, with CRLF', '[@a\r\n\r\nb]', ['a'], []],
		['brackets with a blockquote\'s blank line between', '> [@a\n>\n> b]', ['a'], []],
		['a citation after a blank line in brackets', '[@a\n\n[@b]', ['a', 'b'], ['b']],
		['a citation after a heading, after an unfinished one', '[@draft\n# Heading\n[@smith2020]', ['draft', 'smith2020'], ['smith2020']],
	])('reads %s as main did', (_name, text, keys, exportKeys) => {
		expect(scanCitationUsages(text).map(usage => [usage.key, text.slice(usage.keyStart, usage.keyEnd)])).toEqual(keys.map(key => [key, key]));
		const runs = parseMd(text).flatMap(token => token.runs ?? []).filter(item => item.type === 'citation');
		expect(runs.flatMap(item => item.keys ?? [])).toEqual(exportKeys);
	});

	// Which it bounded by the first ] before the cursor, escaped or not, so
	// it found the key on the line alone, with no [ before it, and no key
	// for go to definition, references or rename. And a guard: an escaped ]
	// that ends the citation, as before, before a [
	test.each([
		['an escaped [ and ] in a locator', '[@a, p. 4 \\[n. 2\\];\n@b]', ['a', 'b']],
		['an escaped ] a later ] ends the citation after', '[@a, x\\] y;\n@b]', ['a', 'b']],
		['an escaped [ in a later item\'s prefix', '[@a;\nsee \\[x\\] @b]', ['a', 'b']],
		['an escaped ] before a [', '[@a, x\\] and\n[@b]', ['a', 'b']],
	])('finds each key at the cursor in a citation over two lines with %s', (_name, text, keys) => {
		const usages = scanCitationUsages(text);
		expect(usages.map(usage => usage.key)).toEqual(keys);
		for (const usage of usages) {
			expect(findCitekeyAtOffset(text, usage.keyStart - 1)).toBe(usage.key);
			expect(findCitekeyAtOffset(text, usage.keyEnd)).toBe(usage.key);
		}
	});

	// Which ended the citation at the first ] before the @, escaped or not,
	// so only a key after a space or a ; was completed there
	test('completes a key after a -@ after an escaped ] a later ] ends the citation after', () => {
		const text = '[@a, x\\] y; -@b]';
		expect(getCompletionContextAtOffset(text, text.indexOf('b]') + 1)?.prefix).toBe('b');
		// A guard: one after an escaped ] that ends the citation, as before
		expect(getCompletionContextAtOffset('[@a, x\\] y -@b', 14)).toBeUndefined();
	});

	// Each [ before the cursor reads past each escaped ] once
	test('finds the key at the cursor after many escaped brackets in linear time', () => {
		const time = (n: number) => {
			const input = ' \\[ \\]'.repeat(80) + ' @b ' + 'x \\] '.repeat(n) + ']';
			const at = input.indexOf('@b') + 1;
			return fastestRun(() => findCitekeyAtOffset(input, at), 5);
		};
		time(4000);
		expect(time(16000) / time(4000)).toBeLessThan(8);
	}, 30000);

	test('finds the key of a citation in brackets after text at the cursor', () => {
		const text = '[text [@smith2020]]';
		expect(findCitekeyAtOffset(text, text.indexOf('smith') + 2)).toBe('smith2020');
	});

	// A guard: the key after a heading, after an unfinished citation, as main
	// found it, at the cursor and among the key's usages
	test('finds the key of a citation after a heading, after an unfinished one', () => {
		const text = '[@draft\n# Heading\n[@smith2020]';
		const at = text.indexOf('smith2020');
		expect(findCitekeyAtOffset(text, at + 2)).toBe('smith2020');
		expect(findUsagesForKey(text, 'smith2020')).toEqual([{ key: 'smith2020', keyStart: at, keyEnd: at + 'smith2020'.length }]);
	});

	// Each [ before a citation's own, and each line, is read once
	test.each([
		['a citation in brackets nested deep', (n: number) => '[x '.repeat(n) + '[@a]' + ']'.repeat(n)],
		['brackets over many lines', (n: number) => '[@a\n\n'.repeat(n) + ']'],
		// Each [ read past each escaped ] to the end again
		['escaped brackets with no ] after them', (n: number) => '[ \\]' + ' \\[ \\]'.repeat(n)],
		['many escaped ] a far ] ends a citation after', (n: number) => '[@a, ' + 'x \\] '.repeat(n) + ']'],
		['many [ before many escaped ] and a [', (n: number) => '[x '.repeat(n) + '\\] '.repeat(n) + '[@a]'],
	])('reads %s in linear time', (_name, text) => {
		const time = (n: number) => {
			const input = text(n);
			return fastestRun(() => scanCitationUsages(input), 5);
		};
		time(4000);
		expect(time(16000) / time(4000)).toBeLessThan(8);
	}, 30000);

	test('finds no usage of a key in a longer one', () => {
		expect(findUsagesForKey('[@smith.2020]', 'smith')).toEqual([]);
		expect(findUsagesForKey('[@smith.2020]', 'smith.2020')).toHaveLength(1);
	});

	test('completes a key with a period from all of it', () => {
		expect(getCompletionContextAtOffset('[@smith.20', 10)?.prefix).toBe('smith.20');
	});

	// An @ a backslash escapes starts no key (see citationItemEnd), and a
	// guard: one after a space does
	test.each(['[cf. \\@x', '[@a; see \\@x', '\\@x'])('completes no key after the escaped @ in %j', text => {
		expect(getCompletionContextAtOffset(text, text.length)).toBeUndefined();
	});

	test('completes a key after an @ after a space in a prefix', () => {
		expect(getCompletionContextAtOffset('[cf. @x', 7)?.prefix).toBe('x');
	});

	// A key with a ; or a ], which ends the citation's item or the citation
	// there, or a backtick, which can start code, so no citation can cite
	// it, and a guard, a key of other characters, which one can
	test.each([
		['a ;', '@article{a;b, title = {T}}', ['a;b']],
		['a ]', '@article{a]b, title = {T}}', ['a]b']],
		['a backtick', '@article{a`b, title = {T}}', ['a`b']],
		['other characters', "@article{a:b.c/d'e, title = {T}}", []],
	])('reports a .bib key with %s as one no citation can cite', (_name, text, keys) => {
		expect(findUncitableBibKeys(parseBibDataFromText('/tmp/test.bib', text).ranges).map(range => range.key)).toEqual(keys);
	});

	// BibTeX reads the first of a field given twice, but biber and this
	// extension the last, so the entry's key reports which fields
	test.each([
		['a field given twice', '@article{a, title = {A}, title = {B}}', [['a', 'title']]],
		['fields given twice, in other cases', '@article{a, Year = 1, title = {A}, YEAR = 2, Title = {B}}', [['a', 'year, title']]],
		['no field given twice', '@article{a, title = {A}}\n@book{a, title = {B}}', []],
	])('reports an entry with %s', (_name, text, entries) => {
		const reported = findRepeatedBibFields(parseBibDataFromText('/tmp/test.bib', text).ranges);
		expect(reported.map(range => [range.key, range.repeatedFields.join(', ')])).toEqual(entries);
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

	test('reads no citation whose ] or [ is in code, as scanCitationUsages does', () => {
		// A [ or ] in code bounds no citation, which a scan of the text from
		// the [ to the ] alone, whose ` it didn't close, read as one
		for (const [text, offset] of [['[@a` ]`', 1], ['`a [`@b ]', 5]] as const) {
			expect(scanCitationUsages(text)).toEqual([]);
			expect(findCitekeyAtOffset(text, offset)).toBeUndefined();
			expect(findCitekeyAtOffset(text, offset + 1)).toBeUndefined();
		}
	});

	test('finds a key that code follows with the cursor just past it, as scanCitationUsages does', () => {
		// The cursor is in the code, but on the key's end, as just before a ]
		const text = '[@n`x`]';
		expect(scanCitationUsages(text).map((u) => [u.key, u.keyEnd])).toEqual([['n', 3]]);
		expect(findCitekeyAtOffset(text, 3)).toBe('n');
		expect(findCitekeyAtOffset(text, 4)).toBeUndefined();
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

	test('does not return completion context for email address', () => {
		const text = 'user@domain';
		const offset = text.length;
		expect(getCompletionContextAtOffset(text, offset)).toBeUndefined();
	});

	test('does not return completion context when letter directly precedes @', () => {
		const text = 'first-last@domain';
		const offset = text.length;
		expect(getCompletionContextAtOffset(text, offset)).toBeUndefined();
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

	test('does not record an offset for an @type{key, inside a field value', () => {
		// `ref1` is prose inside a note, not a declaration — jumping to it would
		// land the user in the middle of another entry's field.
		const text = '@article{key1,\n  note = {see @book{ref1, p.5}},\n  year = {2020}\n}\n';
		const parsed = parseBibDataFromText('/tmp/test.bib', text);
		expect(parsed.keyOffsets.has('key1')).toBe(true);
		expect(parsed.keyOffsets.has('ref1')).toBe(false);
	});

	test('does not record an offset for an entry with no closing brace', () => {
		// The entry never parses, so there is no declaration to navigate to.
		const text = '@article{broken,\n  title = {no close brace';
		const parsed = parseBibDataFromText('/tmp/test.bib', text);
		expect(parsed.entries.size).toBe(0);
		expect(parsed.keyOffsets.has('broken')).toBe(false);
	});

	test('still locates an entry recovered after a malformed one', () => {
		// A user mid-edit with a brace temporarily missing must not lose
		// go-to-definition on every entry below the damage. The parser marks
		// these ranges untrusted for mutation, but navigation still uses them.
		const text = '@article{broken,\n  title = {unterminated\n\n@article{good,\n  year = {2021}\n}';
		const parsed = parseBibDataFromText('/tmp/test.bib', text);
		expect(parsed.entries.has('good')).toBe(true);
		expect(parsed.keyOffsets.get('good')).toBe(text.lastIndexOf('{good') + 1);
		expect(parsed.ranges.every(r => !r.trusted)).toBe(true);
	});

	test('keeps the first declaration when a key is repeated', () => {
		const text = '@article{dup, doi = {10.1/a}}\n@article{dup, doi = {10.2/b}}\n';
		const parsed = parseBibDataFromText('/tmp/test.bib', text);
		expect(parsed.keyOffsets.get('dup')).toBe(text.indexOf('{dup') + 1);
		// Both occurrences remain visible via ranges, even though entries collapses.
		expect(parsed.ranges).toHaveLength(2);
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

