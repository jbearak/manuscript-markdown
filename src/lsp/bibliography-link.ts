/**
 * The link from the bibliography written in a Markdown file's frontmatter,
 * as `bibliography: refs/library`, to its file, which VS Code underlines on
 * Cmd/Ctrl-hover and opens on Cmd/Ctrl-click. No LSP types: returns offsets
 * and a path, which the server converts.
 */

import { resolveWrittenBibliographyPathAsync } from './citekey-language';
import { findBibliographyValue } from './frontmatter-language';

export interface BibliographyLink {
	/** The offsets of the value's first character and past its last, without quotes around it */
	start: number;
	end: number;
	/** The file it opens */
	path: string;
}

/**
 * The link from the bibliography export reads in the frontmatter at the
 * start of `text` (see findBibliographyValue), to the file the server
 * resolves for it as written (see resolveWrittenBibliographyPathAsync).
 * Undefined where the frontmatter gives none, or where no file it could
 * name exists. The file of the document's name, which the server reads
 * where the frontmatter names none that exists, gets no link, as nothing
 * written names it.
 */
export async function findBibliographyLink(
	markdownUri: string,
	text: string,
	workspaceRootPaths: readonly string[],
): Promise<BibliographyLink | undefined> {
	const found = findBibliographyValue(text);
	if (!found) return undefined;
	const path = await resolveWrittenBibliographyPathAsync(markdownUri, found.value, workspaceRootPaths);
	return path === undefined ? undefined : { start: found.start, end: found.end, path };
}
