import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	findBibKeyAtOffset,
	findCitekeyAtOffset,
	fsPathToUri,
	getCompletionContextAtOffset,
	parseBibDataFromText,
	resolveBibliographyPath,
	scanCitationUsages,
} from './citekey-language';

describe('scanCitationUsages', () => {
	test('extracts citekeys from grouped citations with locators', () => {
		const text = 'See [@smith2020, p. 12; @jones2019] for details.';
		const usages = scanCitationUsages(text);
		expect(usages.map((u) => u.key)).toEqual(['smith2020', 'jones2019']);
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

	test('does not return completion context outside citation lists', () => {
		const text = 'email @smi';
		const offset = text.length;
		expect(getCompletionContextAtOffset(text, offset)).toBeUndefined();
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
});
