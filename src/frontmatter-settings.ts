import { createNociteContinuationState, isNociteContinuationLine } from './citekey';
import {
	findFrontmatterBounds,
	findFrontmatterOpeningBounds,
	findFrontmatterRootIndent,
	findYamlMappingColon,
	parseYamlStringScalar,
} from './frontmatter';

export interface FrontmatterMenuSetting {
	key: string;
	label: string;
	group: 'document' | 'typography' | 'tables' | 'citations' | 'code';
	showInToolbar?: boolean;
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
	{ key: 'nocite', label: 'Uncited Bibliography Entries', group: 'citations', showInToolbar: false },
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

function newFrontmatterEdit(eol: '\n' | '\r\n', key: string): FrontmatterSettingEdit {
	const prefix = '---' + eol + key + ': ';
	return {
		offset: 0,
		text: prefix + eol + '---' + eol,
		selectionStart: prefix.length,
		selectionEnd: prefix.length,
	};
}

function multilineNociteSelectionEnd(
	markdown: string,
	bodyEnd: number,
	lineOffset: number,
	selectionStart: number,
	firstValue: string,
	rootIndent: number,
): number {
	const continuation = createNociteContinuationState(firstValue);
	const firstValueEnd = continuation.rootFlowCloseOffset ?? firstValue.length;
	if (continuation.mode === 'single-line') return selectionStart + firstValueEnd;

	let selectionEnd = selectionStart + firstValueEnd;
	let nextLineStart = markdown.indexOf('\n', lineOffset);
	if (nextLineStart === -1 || nextLineStart >= bodyEnd) return selectionEnd;
	nextLineStart++;

	while (nextLineStart < bodyEnd) {
		const newline = markdown.indexOf('\n', nextLineStart);
		const rawLineEnd = newline === -1 || newline > bodyEnd ? bodyEnd : newline;
		const lineEnd = rawLineEnd > nextLineStart && markdown[rawLineEnd - 1] === '\r'
			? rawLineEnd - 1
			: rawLineEnd;
		const line = markdown.slice(nextLineStart, lineEnd);
		const physicalIndent = line.length - line.trimStart().length;
		const logicalStart = Math.min(rootIndent, physicalIndent);
		const logicalLine = line.slice(logicalStart);
		if (!isNociteContinuationLine(continuation, logicalLine)) break;
		selectionEnd = continuation.rootFlowCloseOffset === undefined
			? lineEnd
			: nextLineStart + logicalStart + continuation.rootFlowCloseOffset;
		if (newline === -1 || newline >= bodyEnd) break;
		nextLineStart = newline + 1;
	}
	return selectionEnd;
}

function frontmatterRootIndentText(
	markdown: string,
	bodyStart: number,
	bodyEnd: number,
	rootIndent: number,
): string {
	if (rootIndent === 0) return '';
	let lineStart = bodyStart;
	while (lineStart < bodyEnd) {
		const newline = markdown.indexOf('\n', lineStart);
		const rawEnd = newline === -1 || newline > bodyEnd ? bodyEnd : newline;
		const lineEnd = rawEnd > lineStart && markdown[rawEnd - 1] === '\r'
			? rawEnd - 1
			: rawEnd;
		const line = markdown.slice(lineStart, lineEnd);
		const trimmed = line.trimStart();
		const indent = line.length - trimmed.length;
		if (indent === rootIndent && findYamlMappingColon(trimmed) >= 0) {
			return line.slice(0, rootIndent);
		}
		if (newline === -1 || newline >= bodyEnd) break;
		lineStart = newline + 1;
	}
	return ' '.repeat(rootIndent);
}

interface FrontmatterSettingLine {
	lineOffset: number;
	selectionStart: number;
	value: string;
}

function findFrontmatterSettingLine(
	markdown: string,
	bodyStart: number,
	bodyEnd: number,
	rootIndent: number,
	names: ReadonlySet<string>,
): FrontmatterSettingLine | undefined {
	let lineStart = bodyStart;
	while (lineStart < bodyEnd) {
		const newline = markdown.indexOf('\n', lineStart);
		const rawEnd = newline === -1 || newline > bodyEnd ? bodyEnd : newline;
		const lineEnd = rawEnd > lineStart && markdown[rawEnd - 1] === '\r'
			? rawEnd - 1
			: rawEnd;
		const line = markdown.slice(lineStart, lineEnd);
		const trimmed = line.trimStart();
		const indent = line.length - trimmed.length;
		if (indent === rootIndent) {
			const colon = findYamlMappingColon(trimmed);
			if (
				colon >= 0
				&& names.has(parseYamlStringScalar(trimmed.slice(0, colon)))
			) {
				const afterColon = trimmed.slice(colon + 1);
				const leadingWhitespace = afterColon.match(/^[ \t]*/)?.[0].length ?? 0;
				return {
					lineOffset: lineStart,
					selectionStart: lineStart + rootIndent + colon + 1 + leadingWhitespace,
					value: afterColon.slice(leadingWhitespace),
				};
			}
		}
		if (newline === -1 || newline >= bodyEnd) break;
		lineStart = newline + 1;
	}
	return undefined;
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
	const bounds = findFrontmatterBounds(markdown);
	if (!bounds) return newFrontmatterEdit(eol, key);
	const bodyStart = findFrontmatterOpeningBounds(markdown)!.bodyStart;
	const bodyEnd = bounds.contentEnd;
	const closingOffset = bounds.contentEnd + 1;
	const rootIndent = findFrontmatterRootIndent(markdown, bodyEnd);
	const rootIndentText = frontmatterRootIndentText(
		markdown,
		bodyStart,
		bodyEnd,
		rootIndent,
	);
	const names = new Set([key, ...(FRONTMATTER_ALIASES[key] ?? [])]);
	const settingLine = findFrontmatterSettingLine(
		markdown,
		bodyStart,
		bodyEnd,
		rootIndent,
		names,
	);

	if (settingLine) {
		const selectionStart = settingLine.selectionStart;
		const selectionEnd = key === 'nocite'
			? multilineNociteSelectionEnd(
				markdown,
				bodyEnd,
				settingLine.lineOffset,
				selectionStart,
				settingLine.value,
				rootIndent,
			)
			: selectionStart + settingLine.value.length;
		return {
			offset: selectionStart,
			text: '',
			selectionStart,
			selectionEnd,
		};
	}

	const hasBlankLine = markdown.slice(0, closingOffset).endsWith(eol + eol);
	const offset = hasBlankLine ? closingOffset - eol.length : closingOffset;
	const text = rootIndentText + key + ': ' + eol;
	const cursor = offset + rootIndentText.length + key.length + 2;
	return {
		offset,
		text,
		selectionStart: cursor,
		selectionEnd: cursor,
	};
}
