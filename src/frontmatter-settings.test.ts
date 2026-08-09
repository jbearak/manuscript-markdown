import { describe, expect, test } from 'bun:test';
import {
	FRONTMATTER_MENU_SETTINGS,
	frontmatterSettingCommand,
	getFrontmatterSettingEdit,
} from './frontmatter-settings';
import { FRONTMATTER_SCHEMA } from './lsp/frontmatter-language';

describe('frontmatter setting menu configuration', () => {
	test('includes every canonical frontmatter setting exactly once', () => {
		const menuKeys = FRONTMATTER_MENU_SETTINGS.map(setting => setting.key);
		const schemaKeys = FRONTMATTER_SCHEMA.map(setting => setting.key);
		expect(new Set(menuKeys).size).toBe(menuKeys.length);
		expect([...menuKeys].sort()).toEqual([...schemaKeys].sort());
	});

	test('derives a stable command ID from each setting key', () => {
		expect(frontmatterSettingCommand('table-borders'))
			.toBe('manuscript-markdown.setFrontmatter.table-borders');
	});
});

describe('getFrontmatterSettingEdit', () => {
	test('creates frontmatter with the selected setting when none exists', () => {
		expect(getFrontmatterSettingEdit('# Title\n', '\n', 'font')).toEqual({
			offset: 0,
			text: '---\nfont: \n---\n',
			selectionStart: 10,
			selectionEnd: 10,
		});
	});

	test('inserts a missing setting before the closing delimiter', () => {
		expect(getFrontmatterSettingEdit('---\ntitle: Draft\n---\nBody', '\n', 'font')).toEqual({
			offset: 17,
			text: 'font: \n',
			selectionStart: 23,
			selectionEnd: 23,
		});
	});

	test('uses an existing blank line for a missing setting', () => {
		expect(getFrontmatterSettingEdit('---\r\ntitle: Draft\r\n\r\n---\r\nBody', '\r\n', 'font')).toEqual({
			offset: 19,
			text: 'font: \r\n',
			selectionStart: 25,
			selectionEnd: 25,
		});
	});

	test('selects the value of an existing setting', () => {
		expect(getFrontmatterSettingEdit('---\nfont: Georgia\n---\n', '\n', 'font')).toEqual({
			offset: 10,
			text: '',
			selectionStart: 10,
			selectionEnd: 17,
		});
	});

	test('finds and inserts settings at a consistently indented logical root', () => {
		const existing = '---\n  font: Georgia\n  title: Draft\n---\n';
		const edit = getFrontmatterSettingEdit(existing, '\n', 'font');
		expect(existing.slice(edit.selectionStart, edit.selectionEnd)).toBe('Georgia');
		expect(edit.text).toBe('');

		const missing = '---\n  title: Draft\n---\n';
		const insertion = getFrontmatterSettingEdit(missing, '\n', 'font');
		const applied = missing.slice(0, insertion.offset)
			+ insertion.text
			+ missing.slice(insertion.offset);
		expect(applied).toBe('---\n  title: Draft\n  font: \n---\n');
		expect(insertion.selectionStart).toBe(applied.indexOf('\n---'));
	});

	test('selects an entire multiline nocite value without consuming the next setting', () => {
		for (const markdown of [
			'---\nnocite: # entries\n  - "@org:paper"\n  - @beta\ncsl: apa\n---\n',
			'---\nnocite : # entries\n  - "@org:paper"\n  - @beta\ncsl: apa\n---\n',
			'---\nnocite: |+ # entries\n  @alpha\n  @beta\ncsl: apa\n---\n',
		]) {
			const edit = getFrontmatterSettingEdit(markdown, '\n', 'nocite');
			expect(edit.text).toBe('');
			expect(markdown.slice(edit.selectionStart, edit.selectionEnd)).toMatch(/^# entries|^\|\+ # entries/);
			expect(markdown.slice(edit.selectionStart, edit.selectionEnd)).toContain('@beta');
			expect(markdown.slice(edit.selectionStart, edit.selectionEnd)).not.toContain('csl:');
		}
	});

	test('stops a multiline flow nocite selection at the root collection close', () => {
		const markdown = '---\nnocite: [\n  @alpha\n]\n@beta\n---\n';
		const edit = getFrontmatterSettingEdit(markdown, '\n', 'nocite');
		expect(markdown.slice(edit.selectionStart, edit.selectionEnd)).toBe('[\n  @alpha\n]');
	});

	test('bounds multiline nocite selection at malformed YAML recovery points', () => {
		for (const { markdown, expected } of [
			{
				markdown: '---\nnocite: [\n  @alpha\n] @beta\n---\n',
				expected: '[\n  @alpha\n]',
			},
			{
				markdown: '---\nnocite: [\n  @alpha\n}\ntitle: @hidden\n---\n',
				expected: '[\n  @alpha\n}',
			},
			{
				markdown: '---\nnocite:\n-custom: @outside\n---\n',
				expected: '',
			},
			{
				markdown: '---\nnocite: [\n  @alpha\n-custom: @outside\n---\n',
				expected: '[\n  @alpha',
			},
		]) {
			const edit = getFrontmatterSettingEdit(markdown, '\n', 'nocite');
			expect(markdown.slice(edit.selectionStart, edit.selectionEnd)).toBe(expected);
		}
	});

	test('recognizes an existing alias without rewriting it', () => {
		expect(getFrontmatterSettingEdit('---\nbib: sources.bib\n---\n', '\n', 'bibliography')).toEqual({
			offset: 9,
			text: '',
			selectionStart: 9,
			selectionEnd: 20,
		});
	});

	test('recognizes supported quoted logical-root keys and aliases', () => {
		for (const { markdown, key, expected } of [
			{
				markdown: '---\n"font": Georgia\n---\n',
				key: 'font',
				expected: 'Georgia',
			},
			{
				markdown: "---\n  'font': Georgia\n---\n",
				key: 'font',
				expected: 'Georgia',
			},
			{
				markdown: '---\n"f\\u006fnt": Georgia\n---\n',
				key: 'font',
				expected: 'Georgia',
			},
			{
				markdown: '---\n"b\\u0069b": sources.bib\n---\n',
				key: 'bibliography',
				expected: 'sources.bib',
			},
		]) {
			const edit = getFrontmatterSettingEdit(markdown, '\n', key);
			expect(edit.text).toBe('');
			expect(markdown.slice(edit.selectionStart, edit.selectionEnd)).toBe(expected);
		}
	});

	test('does not treat nested quoted keys as logical-root settings', () => {
		const markdown = '---\nstyles:\n  "font": Georgia\n---\n';
		const edit = getFrontmatterSettingEdit(markdown, '\n', 'font');
		const applied = markdown.slice(0, edit.offset) + edit.text + markdown.slice(edit.offset);
		expect(applied).toBe('---\nstyles:\n  "font": Georgia\nfont: \n---\n');
	});

	test('recognizes frontmatter after a UTF-8 BOM', () => {
		expect(getFrontmatterSettingEdit('\uFEFF---\nfont: Georgia\n---\nBody', '\n', 'font')).toEqual({
			offset: 11,
			text: '',
			selectionStart: 11,
			selectionEnd: 18,
		});
	});

	test('recognizes frontmatter after leading blank lines', () => {
		expect(getFrontmatterSettingEdit('\n\n---\ntitle: Draft\n---\nBody', '\n', 'font')).toEqual({
			offset: 19,
			text: 'font: \n',
			selectionStart: 25,
			selectionEnd: 25,
		});
	});

	test('matches parser handling of opening delimiters with trailing whitespace', () => {
		expect(getFrontmatterSettingEdit('---   \nfont: Georgia\n---\nBody', '\n', 'font')).toEqual({
			offset: 13,
			text: '',
			selectionStart: 13,
			selectionEnd: 20,
		});
	});

	test('recognizes canonical closers and delimiter whitespace without duplicating frontmatter', () => {
		const existing = '---   \nfont: Georgia\n...  \nBody';
		expect(getFrontmatterSettingEdit(existing, '\n', 'font')).toEqual({
			offset: 13,
			text: '',
			selectionStart: 13,
			selectionEnd: 20,
		});

		for (const { markdown, eol, expected } of [
			{
				markdown: '---   \ntitle: Draft\n...  \nBody',
				eol: '\n' as const,
				expected: '---   \ntitle: Draft\nfont: \n...  \nBody',
			},
			{
				markdown: '---\r\ntitle: Draft\r\n---  \r\nBody',
				eol: '\r\n' as const,
				expected: '---\r\ntitle: Draft\r\nfont: \r\n---  \r\nBody',
			},
		]) {
			const edit = getFrontmatterSettingEdit(markdown, eol, 'font');
			const applied = markdown.slice(0, edit.offset) + edit.text + markdown.slice(edit.offset);
			expect(applied).toBe(expected);
			expect(edit.offset).toBeGreaterThan(0);
		}
	});

	test('does not treat longer thematic breaks as frontmatter openers', () => {
		expect(getFrontmatterSettingEdit('----\nfont: Georgia\n---\nBody', '\n', 'font')).toEqual({
			offset: 0,
			text: '---\nfont: \n---\n',
			selectionStart: 10,
			selectionEnd: 10,
		});
	});

	test('creates frontmatter before a leading thematic break', () => {
		expect(getFrontmatterSettingEdit('---\nOpening paragraph.\n', '\n', 'font')).toEqual({
			offset: 0,
			text: '---\nfont: \n---\n',
			selectionStart: 10,
			selectionEnd: 10,
		});
	});

	test('creates closed frontmatter before an unfinished delimiter block', () => {
		expect(getFrontmatterSettingEdit('---\nfont: Georgia', '\n', 'colors')).toEqual({
			offset: 0,
			text: '---\ncolors: \n---\n',
			selectionStart: 12,
			selectionEnd: 12,
		});
	});
});
