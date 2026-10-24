// Which document VS Code's built-in Markdown preview shows.
//
// A command run from the preview's title bar gets a webview-panel URI, not
// the source, and no public API names the source. The preview's tab label
// does: the markdown extension titles it 'Preview <basename>', or
// '[Preview] <basename>' when locked. That only narrows it to a basename and
// only in English, so callers fall back to markdown.showSource whenever this
// returns undefined.
//
// The label is set when the panel is made, before its source is read and
// rendered, so a document rendered before then may be another one of that
// name: only a render after the label took its value counts. Renders and
// label changes share one sequence for that comparison.

/** viewType suffix of the dynamic preview's tab; VS Code prefixes it, as in 'mainThreadWebview-markdown.preview'. */
export const MARKDOWN_PREVIEW_VIEW_TYPE = 'markdown.preview';

export function isMarkdownPreviewViewType(viewType: string): boolean {
	return viewType === MARKDOWN_PREVIEW_VIEW_TYPE || viewType.endsWith('-' + MARKDOWN_PREVIEW_VIEW_TYPE);
}

function basename(uriPath: string): string {
	return uriPath.slice(uriPath.lastIndexOf('/') + 1);
}

export interface RenderedDocument<U extends { path: string }> {
	uri: U;
	/** Sequence number of the document's latest render. */
	seq: number;
}

/**
 * The URI of the one rendered document whose basename the preview's English
 * tab label names, where it rendered after the label took its value at
 * labelSeq; undefined where none or several documents have that basename
 * (two files named notes.md), or the one there is rendered only before.
 */
export function matchPreviewTabLabel<U extends { path: string }>(
	label: string,
	labelSeq: number,
	rendered: Iterable<RenderedDocument<U>>,
): U | undefined {
	const matches = [...rendered].filter(r => {
		const name = basename(r.uri.path);
		return label === 'Preview ' + name || label === '[Preview] ' + name;
	});
	return matches.length === 1 && matches[0].seq > labelSeq ? matches[0].uri : undefined;
}
