import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	canonicalizeFsPath,
	findBibKeyAtOffset,
	findCitekeyAtOffset,
	fsPathToUri,
	getCompletionContextAtOffset,
	isInsideCitationSegmentAtOffset,
	parseBibDataFromText,
	pathsEqual,
	resolveBibliographyPath,
	scanCitationUsages,
} from './citekey-language';

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

	test('does not return completion context for email address', () => {
		const text = 'user@domain';
		const offset = text.length;
		expect(getCompletionContextAtOffset(text, offset)).toBeUndefined();
	});

	test('does not return completion context for hyphenated email address', () => {
		const text = 'first-last@domain';
		const offset = text.length;
		expect(getCompletionContextAtOffset(text, offset)).toBeUndefined();
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
});
