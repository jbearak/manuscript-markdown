/**
 * Pure trigger policy for automatically opening LSP suggestions while typing.
 *
 * Keep this scoped to contexts where this extension can return useful items.
 * VS Code's generic Markdown quick-suggestion policy is intentionally not used
 * because YAML frontmatter is embedded inside a Markdown document.
 */

import { getBoundedCitationCompletionContextAtOffset } from '../citation-scanner';
import {
	getCslCompletionContext,
	shouldAutoTriggerSuggestFromChanges,
	type SuggestTriggerTextChangeLike,
} from './csl-language';
import {
	getFrontmatterCompletionItems,
	getFrontmatterLocation,
} from './frontmatter-language';

export interface AutoSuggestContext {
	enabled: boolean;
	text: string;
	offset: number;
	platform: string;
	changes: readonly SuggestTriggerTextChangeLike[];
}

export function shouldAutoTriggerLspSuggest(context: AutoSuggestContext): boolean {
	if (
		!context.enabled ||
		!shouldAutoTriggerSuggestFromChanges(context.changes)
	) {
		return false;
	}
	if (
		getCslCompletionContext(context.text, context.offset) !== undefined ||
		getBoundedCitationCompletionContextAtOffset(context.text, context.offset) !== undefined
	) {
		return true;
	}

	const location = getFrontmatterLocation(context.text, context.offset);
	if (location.inFrontmatter && !location.frontmatterClosed) {
		const unfinished = assessUnfinishedFrontmatter(
			context.text,
			context.offset,
			location.fmBodyStart ?? 0,
		);
		if (unfinished.hasBodyLikeContent) {
			return false;
		}
		// `---` plus a first bare prefix is indistinguishable from a Markdown
		// thematic break followed by prose. Enter already opened the complete key
		// list, so let the client filter it until a mapping colon establishes YAML.
		if (
			!unfinished.hasTopLevelMapping &&
			unfinished.currentLine.trim().length > 0
		) {
			return false;
		}
	}
	return getFrontmatterCompletionItems(location, context.platform).length > 0;
}

/**
 * An opening `---` is ambiguous with a Markdown thematic break until a closing
 * delimiter is written. Assess only the automatic-popup policy; manual
 * completion remains permissive.
 */
function assessUnfinishedFrontmatter(
	text: string,
	offset: number,
	bodyStart: number,
): {
	currentLine: string;
	hasTopLevelMapping: boolean;
	hasBodyLikeContent: boolean;
} {
	const currentLineStart = text.lastIndexOf('\n', Math.max(bodyStart, offset - 1)) + 1;
	const precedingLines = text.slice(bodyStart, currentLineStart).split(/\r?\n/);
	const currentLine = text.slice(currentLineStart, offset);
	const mappingPattern = /^[A-Za-z0-9_-]+\s*:/;
	const isTopLevelMapping = (line: string): boolean =>
		!/^[ \t]/.test(line) && mappingPattern.test(line.trim());
	const hasTopLevelMapping =
		precedingLines.some(isTopLevelMapping) ||
		isTopLevelMapping(currentLine);
	const hasBodyLikeContent = !hasTopLevelMapping && precedingLines.some(line => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return false;
		if (/^[ \t]/.test(line)) return true;
		if (trimmed.startsWith('#')) return true;
		return !mappingPattern.test(trimmed);
	});
	return { currentLine, hasTopLevelMapping, hasBodyLikeContent };
}
