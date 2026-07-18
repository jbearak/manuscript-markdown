import {
	CompletionItem,
	CompletionItemKind,
	Range,
} from 'vscode-languageserver/node';
import { FrontmatterCompletionItem } from './frontmatter-language';

/**
 * Convert the pure frontmatter completion model into an LSP completion item.
 */
export function toLspFrontmatterCompletionItem(
	item: FrontmatterCompletionItem,
	replaceRange: Range,
): CompletionItem {
	return {
		label: item.label,
		kind: item.kind === 'property' ? CompletionItemKind.Property : CompletionItemKind.Value,
		detail: item.detail,
		textEdit: { range: replaceRange, newText: item.insertText },
		filterText: item.filterText,
		sortText: item.sortText,
		command: item.triggerValueCompletions
			? {
				title: 'Show frontmatter value completions',
				command: 'editor.action.triggerSuggest',
			}
			: undefined,
	};
}
