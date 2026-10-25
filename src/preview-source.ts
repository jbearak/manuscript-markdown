// Which document VS Code's built-in Markdown preview shows.
//
// A command run from the preview's title bar gets a webview-panel URI, not
// the source, and no public API names the source. Only the markdown
// extension knows it, and says so only through markdown.showSource, for the
// preview that has focus. The tab label names just a basename, and a render
// can't be tied to the tab it was for, so neither stands in for it.

/** viewType suffix of the dynamic preview's tab; VS Code prefixes it, as in 'mainThreadWebview-markdown.preview'. */
export const MARKDOWN_PREVIEW_VIEW_TYPE = 'markdown.preview';

export function isMarkdownPreviewViewType(viewType: string): boolean {
	return viewType === MARKDOWN_PREVIEW_VIEW_TYPE || viewType.endsWith('-' + MARKDOWN_PREVIEW_VIEW_TYPE);
}

/** viewType of the static preview, the custom editor of Open With > Markdown Preview. */
export const STATIC_PREVIEW_VIEW_TYPE = 'vscode.markdown.preview.editor';

/**
 * Whether a webview or custom editor tab's viewType is the static preview's:
 * a rendered diff of static previews is a webview tab in newer VS Code.
 */
export function isStaticPreviewViewType(viewType: string): boolean {
	return viewType === STATIC_PREVIEW_VIEW_TYPE || viewType.endsWith('-' + STATIC_PREVIEW_VIEW_TYPE);
}

// The static preview's selector in VS Code 1.143's markdown extension; 1.103's is *.md alone.
const STATIC_PREVIEW_FILE = /\.(md|mkd|mkdn|mdwn|mdown|markdown|markdn|mdtxt|mdtext|litcoffee|ron|ronn|workbook)\b/i;

/**
 * Whether a tab label may name a file the static preview opens, as a diff's
 * 'a.md ↔ b.md' does.
 */
export function labelNamesStaticPreviewFile(label: string): boolean {
	return STATIC_PREVIEW_FILE.test(label);
}

// What may stand beside the file name in a preview's title in any locale:
// white space, the [ ] of a locked preview's, or brackets of other scripts.
const TITLE_SEPARATOR = /[\s[\]()（）「」『』【】]/;

/**
 * Whether a dynamic preview's tab label names a file, as its title, a
 * localized 'Preview {0}' or '[Preview] {0}', always does. It names only the
 * basename, so this can confirm showSource's answer but not stand in for it.
 */
export function previewLabelNamesFile(label: string, uriPath: string): boolean {
	const name = uriPath.slice(uriPath.lastIndexOf('/') + 1);
	if (!name) return false;
	for (let i = label.indexOf(name); i !== -1; i = label.indexOf(name, i + 1)) {
		const end = i + name.length;
		if ((i === 0 || TITLE_SEPARATOR.test(label[i - 1]))
			&& (end === label.length || TITLE_SEPARATOR.test(label[end]))) {
			return true;
		}
	}
	return false;
}

const FOCUS_GROUP_COMMANDS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth']
	.map(n => 'workbench.action.focus' + n + 'EditorGroup');

/**
 * The command that focuses the editor group in a view column, or undefined
 * past the eighth, which has none. Both count groups in VS Code's grid order,
 * auxiliary windows' too; callers still check the group took focus.
 */
export function focusGroupCommand(viewColumn: number): string | undefined {
	return FOCUS_GROUP_COMMANDS[viewColumn - 1];
}

/** Polls `get` every `intervalMs` until it gives a value or `timeoutMs` passes. */
export async function pollFor<T>(
	get: () => T | undefined | PromiseLike<T | undefined>,
	timeoutMs: number,
	intervalMs = 50,
): Promise<T | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await get();
		if (value !== undefined || Date.now() >= deadline) return value;
		await new Promise(resolve => setTimeout(resolve, intervalMs));
	}
}
