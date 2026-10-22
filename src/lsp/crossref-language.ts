// Cross-references to figures and tables, as `@fig-map` or `[@tbl-rates]`,
// as the LSP reads them (see crossRefAt in citation-syntax.ts, which export
// and the preview read them by): the labels the document gives its figures
// and tables, as `{#fig-map}`, the references to them, completion of a
// label after `@fig-` or `@tbl-`, and the diagnostics of a label no
// figure or table has, a label more than one has, and a citation's
// brackets with a cross-reference in them, which Word gets as text. Each
// scan reads the text once, outside code and the frontmatter.

import { computeCodeRegions, isInsideCodeRegion } from '../code-regions';
import { maskFrontmatter } from '../frontmatter';
import { CROSS_REF_AFTER_RE, crossRefLabel, isCitationKeyChar, isCrossRefKey } from '../citation-syntax';

/** A figure's or a table's label, as `fig-map` in `{#fig-map}`, from
 *  `start` to `end`, the label's own characters */
export interface CrossRefLabelDefinition {
	label: string;
	start: number;
	end: number;
}

/** A cross-reference, from `start` to `end`, its @ and key, or for a
 *  citation's brackets with one in them, which are text (`literal`), the
 *  brackets */
export interface CrossRefUsage {
	key: string;
	label: string;
	start: number;
	end: number;
	form: 'bare' | 'bracket' | 'literal';
}

/** `text` with its code and frontmatter as spaces, its offsets kept */
function scannable(text: string): string {
	const masked = maskFrontmatter(text);
	const regions = computeCodeRegions(masked);
	if (regions.length === 0) return masked;
	let out = '';
	let at = 0;
	for (const region of regions) {
		if (region.start < at) continue;
		out += masked.slice(at, region.start) + masked.slice(region.start, region.end).replace(/[^\r\n]/g, ' ');
		at = region.end;
	}
	return out + masked.slice(at);
}

// A label in an attribute block, as `{#fig-map}` or `{#fig-map width=50%}`,
// which export reads after an image or at a table's caption's end
const LABEL_RE = /\{#((?:fig|tbl)-[A-Za-z0-9_-]+)(?=[\s}])/g;
// A bare @ and the key after it, as Pandoc reads one, of a cross-reference
const BARE_RE = /@((?:[Ff]ig|[Tt]bl)-[\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.#$%&\-+?<>~/](?=[\p{L}\p{N}_]))*)/gu;
// Brackets on one line with no others in them
const BRACKETS_RE = /\[[^[\]\r\n]*\]/g;
// A cross-reference's key where a citation reads a key (see holdsCrossRefKey)
const MARK_RE = /(?<![^\s;[])-?@(?:[Ff]ig|[Tt]bl)-[^\s,;\]]/;

/** The labels the document gives its figures and tables, in order, each
 *  time one is given */
export function scanCrossRefLabels(text: string): CrossRefLabelDefinition[] {
	const scan = scannable(text);
	return [...scan.matchAll(LABEL_RE)].map(match => ({ label: match[1], start: match.index + 2, end: match.index + 2 + match[1].length }));
}

/** The document's cross-references, in order, as export reads them: a
 *  citation's brackets with one key alone in them, as `[@fig-map]`, a bare
 *  @ and a key after a character CROSS_REF_AFTER_RE doesn't match, and
 *  brackets with one in them among other text, which are text. Not in a
 *  link's text, whose ] a ( or [ follows. */
export function scanCrossRefs(text: string): CrossRefUsage[] {
	const scan = scannable(text);
	const usages: CrossRefUsage[] = [];
	// The brackets whose text holds none to read, in order
	const skipped: Array<[number, number]> = [];
	for (const match of scan.matchAll(BRACKETS_RE)) {
		const start = match.index;
		const end = start + match[0].length;
		const inner = match[0].slice(1, -1);
		if (inner.startsWith('@') && [...inner.slice(1)].every(isCitationKeyChar) && isCrossRefKey(inner.slice(1))) {
			usages.push({ key: inner.slice(1), label: crossRefLabel(inner.slice(1)), start: start + 1, end: end - 1, form: 'bracket' });
			skipped.push([start, end]);
		} else if (scan[end] === '(' || scan[end] === '[') {
			skipped.push([start, end]);
		} else if (MARK_RE.test(inner)) {
			usages.push({ key: '', label: '', start, end, form: 'literal' });
			skipped.push([start, end]);
		}
	}
	let next = 0;
	for (const match of scan.matchAll(BARE_RE)) {
		const at = match.index;
		while (next < skipped.length && skipped[next][1] <= at) next++;
		if (next < skipped.length && skipped[next][0] < at) continue;
		const before = at > 0 ? scan.slice(Math.max(0, at - 2), at) : '';
		// The character before, whole where it's a surrogate pair's
		const charBefore = before.length === 2 && /[\uDC00-\uDFFF]/.test(before[1]) ? before : before.slice(-1);
		if (CROSS_REF_AFTER_RE.test(charBefore)) continue;
		usages.push({ key: match[1], label: crossRefLabel(match[1]), start: at, end: at + 1 + match[1].length, form: 'bare' });
	}
	return usages.sort((a, b) => a.start - b.start);
}

/** A diagnostic of the cross-references, from `start` to `end` */
export interface CrossRefProblem {
	start: number;
	end: number;
	message: string;
}

/** The cross-references' problems: a reference to a label no figure or
 *  table has, a label more than one has after the first, and a citation's
 *  brackets with a cross-reference among other text */
export function findCrossRefProblems(text: string): CrossRefProblem[] {
	const problems: CrossRefProblem[] = [];
	const labels = new Set<string>();
	for (const { label, start, end } of scanCrossRefLabels(text)) {
		if (labels.has(label)) problems.push({ start, end, message: 'Another figure or table is labeled {#' + label + '} before this one; its cross-references go to the first.' });
		labels.add(label);
	}
	for (const usage of scanCrossRefs(text)) {
		if (usage.form === 'literal') {
			problems.push({ start: usage.start, end: usage.end, message: 'A cross-reference in a citation\'s brackets with other text, as [-@fig-x], [see @fig-x] or [@fig-a; @fig-b], is text in Word: write @fig-x or [@fig-x] alone.' });
		} else if (!labels.has(usage.label)) {
			problems.push({ start: usage.start, end: usage.end, message: 'No figure or table is labeled {#' + usage.label + '}, so Word gets @' + usage.key + ' as text.' });
		}
	}
	return problems.sort((a, b) => a.start - b.start);
}

/** Where a label completes at `offset`, after an @ in a context export
 *  reads a cross-reference in, with what's typed of it so far, `prefix`,
 *  which `fig-` or `tbl-` can start, its first letter a capital or not */
export interface CrossRefCompletionContext {
	/** Where the label starts, which a completion replaces from */
	replaceStart: number;
	prefix: string;
}

export function getCrossRefCompletionContext(text: string, offset: number): CrossRefCompletionContext | undefined {
	if (offset < 0 || offset > text.length) return undefined;
	let replaceStart = offset;
	while (replaceStart > 0 && /[A-Za-z0-9_-]/.test(text.charAt(replaceStart - 1)) && offset - replaceStart < 200) replaceStart--;
	const prefix = text.slice(replaceStart, offset);
	const lower = crossRefLabel(prefix);
	const begun = lower.length >= 4 ? /^(?:fig|tbl)-/.test(lower) : 'fig-'.startsWith(lower) || 'tbl-'.startsWith(lower);
	if (!begun || text.charAt(replaceStart - 1) !== '@') return undefined;
	const before = text.charAt(replaceStart - 2);
	if (before !== '[' && CROSS_REF_AFTER_RE.test(before)) return undefined;
	if (isInsideCodeRegion(replaceStart - 1, computeCodeRegions(text))) return undefined;
	return { replaceStart, prefix };
}

/** The labels a completion at `context` offers, each once, in order, as
 *  written there: `Fig-` or `Tbl-` after a capital */
export function crossRefCompletions(text: string, context: CrossRefCompletionContext): string[] {
	const seen = new Set<string>();
	const lowerPrefix = crossRefLabel(context.prefix);
	const capital = context.prefix !== lowerPrefix;
	const labels: string[] = [];
	for (const { label } of scanCrossRefLabels(text)) {
		if (seen.has(label) || !label.startsWith(lowerPrefix)) continue;
		seen.add(label);
		labels.push(capital ? label.charAt(0).toUpperCase() + label.slice(1) : label);
	}
	return labels;
}

/** The label the cross-reference at `offset` refers to, where one is, and
 *  where its first figure or table gives it, or undefined */
export function findCrossRefDefinition(text: string, offset: number): CrossRefLabelDefinition | undefined {
	const usage = scanCrossRefs(text).find(found => found.form !== 'literal' && offset >= found.start && offset <= found.end);
	if (!usage) return undefined;
	return scanCrossRefLabels(text).find(definition => definition.label === usage.label);
}
