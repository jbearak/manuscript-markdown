/**
 * Pure trigger policy for automatically opening LSP suggestions while typing.
 *
 * Keep this scoped to contexts where this extension can return useful items.
 * VS Code's generic Markdown quick-suggestion policy is intentionally not used
 * because YAML frontmatter is embedded inside a Markdown document.
 */

import { getBoundedCitationCompletionContextAtOffset } from '../citation-scanner';
import { isTopLevelFrontmatterMappingLine } from '../citekey';
import {
	findFrontmatterOpeningBounds,
	findFrontmatterRootIndent,
	findYamlMappingColon,
	parseYamlStringScalar,
} from '../frontmatter';
import {
	getCslCompletionContext,
	shouldAutoTriggerSuggestFromChanges,
	type SuggestTriggerTextChangeLike,
} from './csl-language';
import {
	getFrontmatterCompletionItems,
	getFrontmatterLocation,
	isKnownFrontmatterKey,
} from './frontmatter-language';

export interface AutoSuggestContext {
	enabled: boolean;
	text: string;
	offset: number;
	platform: string;
	changes: readonly SuggestTriggerTextChangeLike[];
}

const MAX_AUTO_SUGGEST_FRONTMATTER_LENGTH = 16_384;

export function shouldAutoTriggerLspSuggest(context: AutoSuggestContext): boolean {
	if (
		!context.enabled ||
		!shouldAutoTriggerSuggestFromChanges(context.changes)
	) {
		return false;
	}
	if (
		getBoundedCitationCompletionContextAtOffset(context.text, context.offset) !== undefined
	) {
		return true;
	}

	const frontmatterText = getBoundedFrontmatterText(context.text, context.offset);
	if (!frontmatterText) return false;
	if (getCslCompletionContext(frontmatterText, context.offset) !== undefined) {
		return true;
	}

	const location = getFrontmatterLocation(frontmatterText, context.offset);
	if (location.inFrontmatter && !location.frontmatterClosed) {
		const unfinished = assessUnfinishedFrontmatter(
			frontmatterText,
			context.offset,
			location.fmBodyStart ?? 0,
		);
		if (
			unfinished.hasBodyLikeContent ||
			(!unfinished.hasTopLevelMapping && (
				unfinished.hasProvisionalMapping ||
				unfinished.hasProvisionalComment ||
				unfinished.currentLine.trim().length > 0
			))
		) {
			return false;
		}
	}
	return getFrontmatterCompletionItems(location, context.platform).length > 0;
}

/** Bound extension-side frontmatter checks; the LSP remains authoritative. */
function getBoundedFrontmatterText(text: string, offset: number): string | undefined {
	const opening = findFrontmatterOpeningBounds(text);
	if (
		!opening ||
		text.charCodeAt(opening.bodyStart - 1) !== 0x0A ||
		offset < opening.bodyStart ||
		offset - opening.bodyStart > MAX_AUTO_SUGGEST_FRONTMATTER_LENGTH
	) {
		return undefined;
	}
	const end = Math.min(
		text.length,
		opening.bodyStart + MAX_AUTO_SUGGEST_FRONTMATTER_LENGTH,
	);
	return end === text.length ? text : text.slice(0, end);
}

/**
 * An unclosed `---` is ambiguous with a Markdown thematic break. Assess only
 * automatic-popup policy; manual completion remains permissive.
 */
function assessUnfinishedFrontmatter(
	text: string,
	offset: number,
	bodyStart: number,
): {
	currentLine: string;
	hasTopLevelMapping: boolean;
	hasBodyLikeContent: boolean;
	hasProvisionalComment: boolean;
	hasProvisionalMapping: boolean;
} {
	const currentLineStart = text.lastIndexOf('\n', Math.max(bodyStart, offset - 1)) + 1;
	const precedingLines = text.slice(bodyStart, currentLineStart).split(/\r?\n/);
	const currentLine = text.slice(currentLineStart, offset);
	const rootIndent = findFrontmatterRootIndent(text, offset);
	const logicalLine = (line: string): string =>
		line.slice(0, rootIndent).trim().length === 0
			? line.slice(rootIndent)
			: line;
	const topLevelKnownMappingKey = (line: string): string | undefined => {
		const logical = logicalLine(line);
		const colon = findYamlMappingColon(logical);
		return colon < 0 ? undefined : parseYamlStringScalar(logical.slice(0, colon));
	};
	const isTopLevelYamlMapping = (line: string): boolean =>
		isTopLevelFrontmatterMappingLine(logicalLine(line));
	let hasTopLevelMapping = false;
	let hasBodyLikeContent = false;
	let hasProvisionalComment = false;
	let hasProvisionalMapping = false;
	for (const line of [...precedingLines, currentLine]) {
		if (hasTopLevelMapping) continue;
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const mappingKey = topLevelKnownMappingKey(line);
		if (mappingKey !== undefined && isKnownFrontmatterKey(mappingKey)) {
			hasTopLevelMapping = true;
		} else if (isTopLevelYamlMapping(line)) {
			hasProvisionalMapping = true;
		} else if (/^[ \t]/.test(line) && hasProvisionalMapping) {
			continue;
		} else if (trimmed.startsWith('#')) {
			hasProvisionalComment = true;
		} else {
			hasBodyLikeContent = true;
		}
	}
	return {
		currentLine,
		hasTopLevelMapping,
		hasBodyLikeContent,
		hasProvisionalComment,
		hasProvisionalMapping,
	};
}
