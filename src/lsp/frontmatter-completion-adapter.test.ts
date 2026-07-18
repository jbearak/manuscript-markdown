import { describe, expect, test } from 'bun:test';
import { Range } from 'vscode-languageserver/node';
import { FrontmatterCompletionItem } from './frontmatter-language';
import { toLspFrontmatterCompletionItem } from './frontmatter-completion-adapter';

const replaceRange = Range.create(1, 0, 1, 3);

function propertyItem(triggerValueCompletions: boolean): FrontmatterCompletionItem {
	return {
		label: 'table-borders',
		insertText: 'table-borders: ',
		kind: 'property',
		filterText: 'table-borders',
		sortText: 'table-borders',
		triggerValueCompletions,
	};
}

describe('toLspFrontmatterCompletionItem', () => {
	test('triggers value suggestions after a property inserts its separator', () => {
		const item = toLspFrontmatterCompletionItem(propertyItem(true), replaceRange);
		expect(item.command).toEqual({
			title: 'Show frontmatter value completions',
			command: 'editor.action.triggerSuggest',
		});
		expect(item.textEdit).toEqual({
			range: replaceRange,
			newText: 'table-borders: ',
		});
	});

	test('does not trigger suggestions for properties without generated values', () => {
		const item = toLspFrontmatterCompletionItem(propertyItem(false), replaceRange);
		expect(item.command).toBeUndefined();
	});

	test('does not trigger suggestions after accepting a value', () => {
		const valueItem: FrontmatterCompletionItem = {
			label: 'none',
			insertText: 'none',
			kind: 'value',
			filterText: 'none',
			sortText: 'none',
		};
		const item = toLspFrontmatterCompletionItem(valueItem, replaceRange);
		expect(item.command).toBeUndefined();
	});
});
