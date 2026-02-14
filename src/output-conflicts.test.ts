import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import {
	getOutputBasePath,
	getOutputConflictMessage,
	getOutputConflictScenario,
} from './output-conflicts';

describe('output conflict helpers', () => {
	it('detects conflict scenario correctly', () => {
		expect(getOutputConflictScenario(false, false)).toBeNull();
		expect(getOutputConflictScenario(true, false)).toBe('md');
		expect(getOutputConflictScenario(false, true)).toBe('bib');
		expect(getOutputConflictScenario(true, true)).toBe('both');
	});

	it('builds a markdown-only conflict message', () => {
		const msg = getOutputConflictMessage('/tmp/article', 'md');
		expect(msg).toContain('"article.md"');
		expect(msg).toContain('already exists in this folder');
		expect(msg).not.toContain('article.bib');
	});

	it('builds a bib-only conflict message', () => {
		const msg = getOutputConflictMessage('/tmp/article', 'bib');
		expect(msg).toContain('"article.bib"');
		expect(msg).toContain('already exists in this folder');
		expect(msg).not.toContain('article.md');
	});

	it('builds a both-files conflict message', () => {
		const msg = getOutputConflictMessage('/tmp/article', 'both');
		expect(msg).toContain('"article.md"');
		expect(msg).toContain('"article.bib"');
		expect(msg).toContain('already exist in this folder');
	});

	it('extracts filename from Windows-style backslash paths', () => {
		const msg = getOutputConflictMessage('C:\\Users\\foo\\article', 'md');
		expect(msg).toContain('"article.md"');
		expect(msg).not.toContain('C:\\');
	});

	it('derives base path from a single selected output name', () => {
		expect(getOutputBasePath('/tmp/new-name.md')).toBe('/tmp/new-name');
		expect(getOutputBasePath('/tmp/new-name')).toBe('/tmp/new-name');
		expect(getOutputBasePath('/tmp/NEW-NAME.MD')).toBe('/tmp/NEW-NAME');
	});

	it('property: (false, false) is always null; any true input is non-null', () => {
		fc.assert(
			fc.property(fc.boolean(), fc.boolean(), (md, bib) => {
				const result = getOutputConflictScenario(md, bib);
				if (!md && !bib) {
					expect(result).toBeNull();
				} else {
					expect(result).not.toBeNull();
				}
			}),
			{ numRuns: 100 }
		);
	});

	it('property: getOutputBasePath stripping .md is idempotent', () => {
		fc.assert(
			fc.property(fc.string(), (path) => {
				const once = getOutputBasePath(path);
				const twice = getOutputBasePath(once);
				expect(twice).toBe(once);
			}),
			{ numRuns: 200 }
		);
	});
});
