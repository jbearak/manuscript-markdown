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
