import { isCitekeyChar } from '../citekey';
import type { CitationDocumentAnalysis } from '../citation-scanner';
import {
	getCompletionContextAtOffset,
	type CompletionContextAtOffset,
} from './citekey-language';
import { findFrontmatterBounds } from '../frontmatter';
import {
	getFrontmatterLocation,
	type FrontmatterLocation,
} from './frontmatter-language';

export interface CompletionRouting {
	frontmatterLocation: FrontmatterLocation;
	citationContext?: CompletionContextAtOffset;
}

function hasCitationMarkerAtOffset(text: string, offset: number): boolean {
	let replaceStart = offset;
	while (replaceStart > 0 && isCitekeyChar(text[replaceStart - 1])) replaceStart--;
	return replaceStart > 0 && text[replaceStart - 1] === '@';
}

/**
 * Route cheap frontmatter completion before requesting whole-document citation
 * analysis. Citation analysis is still authoritative whenever the cursor follows
 * an @ marker, including inside multiline nocite values.
 */
export function getCompletionRoutingAtOffset(
	text: string,
	offset: number,
	getCitationAnalysis: () => CitationDocumentAnalysis,
): CompletionRouting {
	let frontmatterLocation = getFrontmatterLocation(text, offset);
	if (!frontmatterLocation.inFrontmatter) {
		const authoritativeBounds = findFrontmatterBounds(text);
		if (authoritativeBounds) {
			frontmatterLocation = getFrontmatterLocation(text, offset, authoritativeBounds);
		}
	}
	if (!hasCitationMarkerAtOffset(text, offset)) {
		return { frontmatterLocation };
	}

	const citationAnalysis = getCitationAnalysis();
	return {
		frontmatterLocation,
		citationContext: getCompletionContextAtOffset(text, offset, citationAnalysis),
	};
}
