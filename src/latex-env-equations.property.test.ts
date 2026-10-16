import { describe, test, expect } from 'bun:test';
import { displayZones } from './latex-env-preprocess';
import { createMarkdownIt } from './md-to-docx';
import { preprocessBlocks } from './block-preprocess';
import { preprocessCriticMarkup, PARA_PLACEHOLDER, LINE_PLACEHOLDER } from './critic-markup';

// The fences of the display math the wrapper reads to leave the
// environments in it as they are (see step 4 of computeInertZones in
// latex-env-preprocess.ts), against those of the display math export's own
// parse reads, as the source offsets of its math tokens' fences, over
// generated paragraphs of inline constructs nested two or three deep, with
// dollar signs and fences in each and line ends between them: links,
// images, highlights, CriticMarkup, citations, autolinks, URLs, code spans,
// comments and HTML. None holds a bare environment, so export reads the text
// the wrapper read. Each difference was a shape of the text where the
// wrapper's read of export's state was wrong, which a test found one at a
// time: a citation whose prefix held an equation, a highlight's text in a
// link, a substitution without its ~>, and others. Where the wrapper can't
// read export's state with certainty, it finds no display math in the text,
// and the wrap takes main's decisions there, which this counts apart

const D = '$' + '$';

/** mulberry32, in 32-bit integer arithmetic throughout, so each seed gives
 *  its own documents */
function random(seed: number): () => number {
	let state = seed | 0;
	return () => {
		state = (state + 0x6D2B79F5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const leaves = [
	'a', 'b c', '$x$', '$a+b$', '$', ' $ ', D, D + 'x' + D, D + '\nw x\n' + D, D + D, D + ' y ' + D, '$x' + D + 'y$', '\\' + D + 'x' + D,
	'$\nw y\n$', '\\$', '$5', 'x$y',
	'`$`', '`' + D + '`', '`', '``$``',
	'http://x.org/$y', 'http://x.org/' + D, '<http://x/$y>', '<a$b@x.org>',
	'<span title="$">', '<span title=' + D + '>', '</span>', '<a href="u">', '</a>', '<b>', '</b>',
	'<!-- $ -->', '<!-- ' + D + ' -->', '<!--', '-->', '&#36;',
	'@ref', ';', ',', '==', '{++', '++}', '[', ']', '*', '{#c1}', '{/c1}', '[^1]', '[x][a$b]', '[a$b]', '[x][r]',
];

/** Each construct around one or two texts, and whether it is CriticMarkup,
 *  whose line ends preprocessCriticMarkup puts in placeholders */
const wraps: Array<{ critic: boolean; wrap: (a: string, b: string) => string }> = [
	{ critic: false, wrap: a => '[' + a + '](u)' },
	{ critic: false, wrap: a => '[' + a + '](x/$y)' },
	{ critic: false, wrap: a => '[' + a + '](u "t $")' },
	{ critic: false, wrap: a => '![' + a + '](x.png)' },
	{ critic: false, wrap: a => '[' + a + ']' },
	{ critic: false, wrap: a => '==' + a + '==' },
	{ critic: false, wrap: a => '==' + a + '=={red}' },
	{ critic: true, wrap: a => '{++' + a + '++}' },
	{ critic: true, wrap: a => '{--' + a + '--}' },
	{ critic: true, wrap: a => '{==' + a + '==}' },
	{ critic: true, wrap: a => '{>>' + a + '<<}' },
	{ critic: true, wrap: (a, b) => '{~~' + a + '~>' + b + '~~}' },
	{ critic: true, wrap: a => '{#c2>>' + a + '<<}' },
	{ critic: true, wrap: a => '{~~' + a + '~~}' },
	{ critic: false, wrap: a => '[' + a + '][r]' },
	{ critic: false, wrap: a => '[see ' + a + ' @ref]' },
	{ critic: false, wrap: a => '[@ref, ' + a + ']' },
	{ critic: false, wrap: (a, b) => '[see ' + a + ' @ref, ' + b + ']' },
	{ critic: false, wrap: (a, b) => '[' + a + ' @ref; ' + b + ' @key]' },
	{ critic: false, wrap: a => '*' + a + '*' },
	{ critic: false, wrap: a => '**' + a + '**' },
	{ critic: false, wrap: a => '~~' + a + '~~' },
	{ critic: false, wrap: a => '<b>' + a + '</b>' },
	{ critic: false, wrap: a => '<a href="u">' + a + '</a>' },
	{ critic: false, wrap: a => '`' + a + '`' },
];

/** Documents of one or two paragraphs or headings, in a quote or a list
 *  item where `blocks` is, with line ends in CriticMarkup where
 *  `criticLines` is, and the link definitions their links read */
function documents(seed: number, count: number, criticLines: boolean, blocks: boolean): string[] {
	const rnd = random(seed);
	const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
	const items = (depth: number, lines: boolean): string => {
		const n = 1 + Math.floor(rnd() * 3);
		const parts: string[] = [];
		for (let i = 0; i < n; i++) {
			if (depth > 0 && rnd() < 0.55) {
				const { critic, wrap } = pick(wraps);
				const inner = lines && (criticLines || !critic);
				parts.push(wrap(items(depth - 1, inner), items(depth - 1, inner)));
			} else {
				let leaf = pick(leaves);
				while (!lines && leaf.includes('\n')) leaf = pick(leaves);
				parts.push(leaf);
			}
		}
		return parts.map((part, i) => {
			const r = rnd();
			return (i === 0 ? '' : lines && r < 0.04 ? '\n\nw ' : lines && r < 0.22 ? '\nw ' : ' ') + part;
		}).join('');
	};
	const contain = (paragraph: string) => {
		if (!blocks) return paragraph;
		const r = rnd();
		if (r < 0.25) return paragraph.split('\n').map(line => line === '' ? '>' : '> ' + line).join('\n');
		if (r < 0.5) return paragraph.split('\n').map((line, i) => i === 0 ? '- ' + line : line === '' ? '' : '  ' + line).join('\n');
		return paragraph;
	};
	const docs: string[] = [];
	for (let d = 0; d < count; d++) {
		const paragraphs: string[] = [];
		const k = 1 + Math.floor(rnd() * 2);
		for (let i = 0; i < k; i++) paragraphs.push(contain((rnd() < 0.15 ? '# H ' : 'P ') + items(1 + Math.floor(rnd() * 3), true)));
		docs.push(paragraphs.join('\n\n') + '\n\n[r]: u\n[a$b]: v\n');
	}
	return docs;
}

/** For each offset of the text export parses, with CriticMarkup's line ends
 *  in placeholders, and the quote markers after them out, that of `raw`, or
 *  null where they don't line up, as where an opener at a line's end was
 *  moved past it */
function sourceOffsets(processed: string, raw: string): number[] | null {
	const map: number[] = [];
	let j = 0;
	// The raw text a placeholder at i stands for, from j: a line end, or a
	// blank line, with as many of the quote markers after it as leave the rest
	// of the raw text, up to the next placeholder, as the processed text
	const stands = (i: number, re: RegExp, size: number) => {
		const m = re.exec(raw.slice(j, j + 256));
		if (!m) return -1;
		const ahead = processed.slice(i + size, i + size + 16);
		const next = ahead.includes('') ? ahead.slice(0, ahead.indexOf('')) : ahead;
		for (let len = m[0].length; len > 0; len--) {
			const rest = raw.slice(j + len, j + len + next.length + 1);
			if (rest.startsWith(next) && (next.length === ahead.length || rest[next.length] === '\n')) return len;
		}
		return -1;
	};
	for (let i = 0; i < processed.length;) {
		const para = processed.startsWith(PARA_PLACEHOLDER, i);
		const size = para ? PARA_PLACEHOLDER.length : processed.startsWith(LINE_PLACEHOLDER, i) ? LINE_PLACEHOLDER.length : 0;
		if (size) {
			const len = stands(i, para ? /^\n(?:[ \t]{0,3}>[ \t]?)*[ \t]*\n(?:[ \t]{0,3}>[ \t]?)*/ : /^\n(?:[ \t]{0,3}>[ \t]?)*/, size);
			if (len === -1) return null;
			for (let k = 0; k < size; k++) map.push(j);
			i += size;
			j += len;
			continue;
		}
		if (processed[i] !== raw[j]) return null;
		map.push(j);
		i++;
		j++;
	}
	if (j !== raw.length) return null;
	map.push(j);
	return map;
}

interface Range { start: number; end: number }

/** The source range of each display math token export's parse of
 *  `processed` reads in a text whose offsets in `text` are known: a paragraph's or a
 *  heading's, a link's text, which markdown-it reads with that state, and a
 *  highlight's text or an image's alt, which it reads in a state of its own
 *  at an offset in that one. And how many it read in others, as a citation's
 *  item, and whether an inline text's lines didn't line up with those of
 *  `processed` */
function exportEquations(processed: string): { ranges: Range[]; unplaced: number; unmapped: boolean } {
	const md = createMarkdownIt();
	const ranges: Range[] = [];
	let unplaced = 0;
	let unmapped = false;
	// Where each state's text starts in that of the inline text read, and
	// for each offset of that text, the text's
	type Place = { offset: number; map: number[] };
	const places = new WeakMap<object, Place | null>();
	const stack: Array<{ src: string; pos: number }> = [];
	let inlineMap: number[] | undefined;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const inline = md.inline as any;
	const State = inline.State;
	inline.State = class extends State {
		constructor(src: string, m: unknown, env: unknown, out: unknown) {
			super(src, m, env, out);
			const parent = stack[stack.length - 1];
			let place: Place | null = null;
			if (!parent) place = inlineMap ? { offset: 0, map: inlineMap } : null;
			else {
				const p = places.get(parent);
				// A scan ahead in the same text, as citationEnd's, or a highlight's
				// text or an image's alt, from two past the state's position
				if (p && src === parent.src) place = p;
				else if (p && parent.src.startsWith(src, parent.pos + 2)) place = { offset: p.offset + parent.pos + 2, map: p.map };
			}
			places.set(this, place);
		}
	};
	const tokenize = inline.tokenize.bind(inline);
	inline.tokenize = (state: { src: string; pos: number }) => {
		stack.push(state);
		try {
			tokenize(state);
		} finally {
			stack.pop();
		}
	};
	const rules = inline.ruler.__rules__ as Array<{ name: string; fn: (state: { pos: number }, silent: boolean) => boolean }>;
	const math = rules.find(rule => rule.name === 'math')!.fn;
	md.inline.ruler.at('math', (state, silent) => {
		const start = state.pos;
		const read = math(state, silent);
		// Display math's, from a fence of two dollar signs
		if (read && !silent && (state as unknown as { src: string }).src.startsWith('$' + '$', start)) {
			const place = places.get(state);
			if (!place) unplaced++;
			else ranges.push({ start: place.map[place.offset + start], end: place.map[place.offset + state.pos] });
		}
		return read;
	});
	const processedStarts = [0];
	for (let i = 0; i < processed.length; i++) if (processed[i] === '\n') processedStarts.push(i + 1);
	md.core.ruler.at('inline', state => {
		for (const token of state.tokens) {
			if (token.type !== 'inline') continue;
			// Each line of its text, but the last, ends a line of the text, as
			// after a quote's marker or an item's indent, and the last does but
			// for the spaces markdown-it trims. Its offsets are those of the
			// processed text, whose lines the block parse read
			inlineMap = token.map ? [] : undefined;
			const contentLines = token.content.split('\n');
			for (let k = 0; inlineMap && token.map && k < contentLines.length; k++) {
				const line = token.map[0] + k;
				const whole = processed.slice(processedStarts[line], (processedStarts[line + 1] ?? processed.length + 1) - 1);
				const content = contentLines[k];
				const column = whole.endsWith(content) ? whole.length - content.length : whole.trimEnd().endsWith(content) ? whole.trimEnd().length - content.length : -1;
				if (column === -1 || (k === 0 && !/^[\s>#*+-]*$/.test(whole.slice(0, column)))) inlineMap = undefined;
				else for (let x = 0; x <= content.length; x++) inlineMap.push(processedStarts[line] + column + x);
			}
			if (!inlineMap) unmapped = true;
			state.md.inline.parse(token.content, state.md, state.env, token.children!);
			inlineMap = undefined;
		}
	});
	md.parse(processed, {});
	return { ranges, unplaced, unmapped };
}

/** How the fences of the wrapper's display math in each of `docs` compare
 *  with export's */
function compare(docs: string[]) {
	let compared = 0;
	let fellBack = 0;
	let displays = 0;
	const differences: string[] = [];
	for (const raw of docs) {
		const { deLazified, output } = preprocessBlocks(raw);
		// No environment to wrap, so export reads the text the wrapper does
		expect(output).toBe(deLazified);
		const text = deLazified;
		const processed = preprocessCriticMarkup(output);
		const offsets = processed === text ? null : sourceOffsets(processed, text);
		if (processed !== text && !offsets) continue;
		const found = exportEquations(processed);
		if (found.unmapped) continue;
		compared++;
		const exported = found.ranges.map(r => offsets ? { start: offsets[r.start], end: offsets[r.end] } : r);
		const { displays: read, fallbacks } = displayZones(text);
		if (fallbacks.length > 0) fellBack++;
		// Out of the texts the wrapper can't read for certain, which hold
		// none of its display math
		const outside = exported.filter(r => !fallbacks.some(f => f.start < r.end && r.start < f.end));
		displays += outside.length;
		// Its opening fence and its closing one
		const fences = (ranges: Range[]) => ranges.slice().sort((a, b) => a.start - b.start).map(r => text.slice(r.start, r.end) + ' with fences at ' + r.start + ' and ' + (r.end - 2));
		const ours = fences(read);
		const theirs = fences(outside);
		if (ours.join('\n') !== theirs.join('\n') && differences.length < 5) {
			differences.push(JSON.stringify(text) + '\n  export: ' + JSON.stringify(theirs) + '\n  wrapper: ' + JSON.stringify(ours));
		}
	}
	return { compared, fellBack, displays, differences };
}

describe('the display math the wrapper reads around a bare environment, against export\'s parse', () => {
	test.each([
		['without line ends in CriticMarkup', 1, false, false],
		['with line ends in CriticMarkup, in quotes and list items', 2, true, true],
	])('are export\'s in documents of nested constructs %s', (_name, seed, criticLines, blocks) => {
		const count = 2000;
		const { compared, fellBack, displays, differences } = compare(documents(seed, count, criticLines, blocks));
		expect(differences).toEqual([]);
		// Nearly all are compared, with display math in many, and few are read
		// as main read them
		expect(compared).toBeGreaterThan(count * 0.97);
		expect(displays).toBeGreaterThan(count / 6);
		expect(fellBack).toBeLessThan(count * 0.05);
	}, 60000);
});
