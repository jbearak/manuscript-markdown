// Which document VS Code's built-in Markdown preview shows.
//
// A command run from the preview's title bar gets a webview-panel URI, not
// the source, and no public API names the source. The preview's tab label
// does: the markdown extension titles it 'Preview <basename>', or
// '[Preview] <basename>' when locked. That only narrows it to a basename and
// only in English, so callers fall back to markdown.showSource whenever this
// returns undefined.

/** viewType suffix of the dynamic preview's tab; VS Code prefixes it, as in 'mainThreadWebview-markdown.preview'. */
export const MARKDOWN_PREVIEW_VIEW_TYPE = 'markdown.preview';

export function isMarkdownPreviewViewType(viewType: string): boolean {
	return viewType === MARKDOWN_PREVIEW_VIEW_TYPE || viewType.endsWith('-' + MARKDOWN_PREVIEW_VIEW_TYPE);
}

function basename(uriPath: string): string {
	return uriPath.slice(uriPath.lastIndexOf('/') + 1);
}

/**
 * The one URI whose basename the preview's English tab label names, or
 * undefined where none or several do (two files named notes.md).
 */
export function matchPreviewTabLabel<T extends { path: string }>(
	label: string,
	candidates: readonly T[],
): T | undefined {
	const matches = candidates.filter(c => {
		const name = basename(c.path);
		return label === 'Preview ' + name || label === '[Preview] ' + name;
	});
	return matches.length === 1 ? matches[0] : undefined;
}
