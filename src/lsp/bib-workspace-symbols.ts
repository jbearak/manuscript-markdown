/**
 * Workspace symbols (Go to Symbol in Workspace, `#` in Quick Open) for the
 * citation keys of every `.bib` file in the workspace.
 *
 * The server does not scan the workspace tree itself (see "Bib file pairing"
 * in docs/language-server.md); it asks the client for the workspace's `.bib`
 * files with WORKSPACE_BIB_FILES_REQUEST, which the client answers with
 * `vscode.workspace.findFiles`, so `files.exclude` applies.
 *
 * Kept free of runtime imports from vscode-languageserver: the extension
 * imports the request name from here.
 */

import type { ParsedBibData } from './citekey-language';

/** Client request: returns the URIs of the workspace's `.bib` files. */
export const WORKSPACE_BIB_FILES_REQUEST = 'manuscriptMarkdown/workspaceBibFiles';

export interface BibKeyMatch {
	key: string;
	keyStart: number;
	keyEnd: number;
}

/**
 * Whether a workspace symbol query matches a key: the query's characters
 * appear in the key in order, ignoring case. VS Code ranks and filters the
 * results again by its own fuzzy score, so this only has to keep every key
 * VS Code could show.
 */
export function matchesWorkspaceSymbolQuery(key: string, query: string): boolean {
	const k = key.toLowerCase();
	let i = 0;
	for (const ch of query.toLowerCase()) {
		if (/\s/.test(ch)) {
			continue;
		}
		i = k.indexOf(ch, i);
		if (i < 0) {
			return false;
		}
		i += ch.length;
	}
	return true;
}

/** Each declaration in `bib` whose key matches `query`, in source order.
 *  A key declared twice gives both, as the `.bib` document's outline does. */
export function findBibKeyMatches(bib: ParsedBibData, query: string): BibKeyMatch[] {
	const matches: BibKeyMatch[] = [];
	for (const r of bib.ranges) {
		if (!bib.entries.has(r.key) || !matchesWorkspaceSymbolQuery(r.key, query)) {
			continue;
		}
		matches.push({ key: r.key, keyStart: r.keyStart, keyEnd: r.keyEnd });
	}
	return matches;
}
