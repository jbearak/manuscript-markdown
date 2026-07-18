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

	test('recognizes an existing alias without rewriting it', () => {
		expect(getFrontmatterSettingEdit('---\nbib: sources.bib\n---\n', '\n', 'bibliography')).toEqual({
			offset: 9,
			text: '',
			selectionStart: 9,
			selectionEnd: 20,
		});
	});

	test('adds the selected setting to unfinished frontmatter', () => {
		expect(getFrontmatterSettingEdit('---\nfont: Georgia', '\n', 'colors')).toEqual({
			offset: 17,
			text: '\ncolors: ',
			selectionStart: 26,
			selectionEnd: 26,
		});
	});
});
