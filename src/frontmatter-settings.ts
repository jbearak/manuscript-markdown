export interface FrontmatterMenuSetting {
	key: string;
	label: string;
	group: 'document' | 'typography' | 'tables' | 'citations' | 'code';
}

export const FRONTMATTER_MENU_SETTINGS: readonly FrontmatterMenuSetting[] = [
	{ key: 'title', label: 'Title', group: 'document' },
	{ key: 'author', label: 'Author', group: 'document' },
	{ key: 'timezone', label: 'Timezone', group: 'document' },
	{ key: 'breaks', label: 'Hard Line Breaks', group: 'document' },

	{ key: 'font', label: 'Body Font', group: 'typography' },
	{ key: 'font-size', label: 'Body Font Size', group: 'typography' },
	{ key: 'line-spacing', label: 'Line Spacing', group: 'typography' },
	{ key: 'paragraph-indent', label: 'Paragraph Indent', group: 'typography' },
	{ key: 'header-font', label: 'Heading Font', group: 'typography' },
	{ key: 'header-font-size', label: 'Heading Font Size', group: 'typography' },
	{ key: 'header-font-style', label: 'Heading Font Style', group: 'typography' },
	{ key: 'title-font', label: 'Title Font', group: 'typography' },
	{ key: 'title-font-size', label: 'Title Font Size', group: 'typography' },
	{ key: 'title-font-style', label: 'Title Font Style', group: 'typography' },
	{ key: 'blockquote-style', label: 'Blockquote Style', group: 'typography' },
	{ key: 'callout-labels', label: 'Callout Labels', group: 'typography' },
	{ key: 'colors', label: 'Color Scheme', group: 'typography' },
	{ key: 'styles', label: 'Custom Styles', group: 'typography' },

	{ key: 'table-font', label: 'Table Font', group: 'tables' },
	{ key: 'table-font-size', label: 'Table Font Size', group: 'tables' },
	{ key: 'table-col-widths', label: 'Column Widths', group: 'tables' },
	{ key: 'table-borders', label: 'Borders', group: 'tables' },
	{ key: 'table-digits', label: 'Decimal Digits', group: 'tables' },
	{ key: 'table-decimal-mark', label: 'Decimal Mark', group: 'tables' },
	{ key: 'table-digit-grouping', label: 'Digit Grouping', group: 'tables' },
	{ key: 'pipe-table-max-line-width', label: 'Pipe Table Maximum Line Width', group: 'tables' },
	{ key: 'grid-table-max-line-width', label: 'Grid Table Maximum Line Width', group: 'tables' },

	{ key: 'bibliography', label: 'Bibliography File', group: 'citations' },
	{ key: 'csl', label: 'Citation Style', group: 'citations' },
	{ key: 'locale', label: 'Citation Locale', group: 'citations' },
	{ key: 'zotero-notes', label: 'Zotero Citation Placement', group: 'citations' },
	{ key: 'notes', label: 'Footnotes or Endnotes', group: 'citations' },
	{ key: 'bibliography-hanging-indent', label: 'Bibliography Hanging Indent', group: 'citations' },

	{ key: 'code-font', label: 'Code Font', group: 'code' },
	{ key: 'code-font-size', label: 'Code Font Size', group: 'code' },
	{ key: 'code-background-color', label: 'Background Color', group: 'code' },
	{ key: 'code-font-color', label: 'Font Color', group: 'code' },
	{ key: 'code-block-inset', label: 'Block Inset', group: 'code' },
];

const FRONTMATTER_ALIASES: Readonly<Record<string, readonly string[]>> = {
	bibliography: ['bib', 'bibtex'],
	'zotero-notes': ['note-type'],
	'code-background-color': ['code-background'],
	'code-font-color': ['code-color'],
};

export function frontmatterSettingCommand(key: string): string {
	return 'manuscript-markdown.setFrontmatter.' + key;
}

export interface FrontmatterSettingEdit {
	offset: number;
	text: string;
	selectionStart: number;
	selectionEnd: number;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function newFrontmatterEdit(eol: '\n' | '\r\n', key: string): FrontmatterSettingEdit {
	const prefix = '---' + eol + key + ': ';
	return {
		offset: 0,
		text: prefix + eol + '---' + eol,
		selectionStart: prefix.length,
		selectionEnd: prefix.length,
	};
}

/**
 * Locate an existing setting value or prepare an insertion for a missing one.
 * Existing frontmatter content and key aliases are preserved.
 */
export function getFrontmatterSettingEdit(
	markdown: string,
	eol: '\n' | '\r\n',
	key: string,
): FrontmatterSettingEdit {
	// Match parseFrontmatter's treatment of leading whitespace and UTF-8 BOMs.
	const openingOffset = markdown.length - markdown.trimStart().length;
	const trimmed = markdown.slice(openingOffset);
	if (!trimmed.startsWith('---')) {
		return newFrontmatterEdit(eol, key);
	}

	const bodyStart = openingOffset + 3;
	const closingMatch = /\n---(?:\r?\n|$)/.exec(markdown.slice(bodyStart));
	if (!closingMatch) {
		// Without a closing delimiter, the converter treats the text as Markdown.
		return newFrontmatterEdit(eol, key);
	}
	const bodyEnd = bodyStart + closingMatch.index + 1;
	const names = [key, ...(FRONTMATTER_ALIASES[key] ?? [])].map(escapeRegex);
	const settingPattern = new RegExp('^(?:' + names.join('|') + '):([ \\t]*)(.*?)(\\r?)$', 'm');
	const settingMatch = settingPattern.exec(markdown.slice(bodyStart, bodyEnd));

	if (settingMatch) {
		const lineOffset = bodyStart + settingMatch.index;
		const colonOffset = markdown.indexOf(':', lineOffset);
		const selectionStart = colonOffset + 1 + settingMatch[1].length;
		return {
			offset: selectionStart,
			text: '',
			selectionStart,
			selectionEnd: selectionStart + settingMatch[2].length,
		};
	}

	const closingOffset = bodyEnd;
	const hasBlankLine = markdown.slice(0, closingOffset).endsWith(eol + eol);
	const offset = hasBlankLine ? closingOffset - eol.length : closingOffset;
	const text = key + ': ' + eol;
	const cursor = offset + key.length + 2;
	return {
		offset,
		text,
		selectionStart: cursor,
		selectionEnd: cursor,
	};
}
