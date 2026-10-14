import { describe, test, expect } from 'bun:test';
import {
	findCommentIdAtOffset,
	findRangeTextForId,
	stripCriticMarkup,
} from './comment-language';
import { fastestRun } from '../test-timing';
import fc from 'fast-check';
import { findMatchingClose } from '../critic-markup';

describe('findCommentIdAtOffset', () => {
	test('returns id when cursor is inside a comment body', () => {
		const text = 'Some text\n\n{#1>>alice: note<<}';
		// Offset pointing to 'a' in 'alice'
		const bodyStart = text.indexOf('{#1>>');
		expect(findCommentIdAtOffset(text, bodyStart + 5)).toBe('1');
	});

	test('returns id when cursor is on the opening delimiter', () => {
		const text = '{#abc>>comment<<}';
		expect(findCommentIdAtOffset(text, 0)).toBe('abc');
	});

	test('returns id when cursor is just before the closing delimiter', () => {
		const text = '{#abc>>comment<<}';
		// Last char before closing: 't' at index 13
		expect(findCommentIdAtOffset(text, 13)).toBe('abc');
	});

	test('returns undefined when cursor is past the closing delimiter', () => {
		const text = '{#abc>>comment<<} after';
		expect(findCommentIdAtOffset(text, 17)).toBeUndefined();
	});

	test('returns undefined when cursor is outside any comment body', () => {
		const text = 'no comments here';
		expect(findCommentIdAtOffset(text, 5)).toBeUndefined();
	});

	test('returns undefined when cursor is on a range marker, not a body', () => {
		const text = '{#1}text{/1}';
		expect(findCommentIdAtOffset(text, 0)).toBeUndefined();
	});

	test('handles multiple comment bodies with different IDs', () => {
		const text = '{#1>>first<<}\n{#2>>second<<}';
		const idx1 = text.indexOf('{#1>>');
		const idx2 = text.indexOf('{#2>>');
		expect(findCommentIdAtOffset(text, idx1 + 5)).toBe('1');
		expect(findCommentIdAtOffset(text, idx2 + 5)).toBe('2');
	});

	test('handles non-numeric IDs', () => {
		const text = '{#intro-note>>some comment<<}';
		expect(findCommentIdAtOffset(text, 15)).toBe('intro-note');
	});
});

describe('findRangeTextForId', () => {
	test('returns text between matching start and end markers', () => {
		const text = '{#1}hello world{/1}';
		expect(findRangeTextForId(text, '1')).toBe('hello world');
	});

	test('returns undefined when no start marker exists', () => {
		const text = 'no markers here';
		expect(findRangeTextForId(text, '1')).toBeUndefined();
	});

	test('returns undefined when no end marker exists', () => {
		const text = '{#1}text without end';
		expect(findRangeTextForId(text, '1')).toBeUndefined();
	});

	test('returns text containing CriticMarkup (not stripped)', () => {
		const text = '{#1}{==highlighted==}{>>comment<<}{/1}';
		expect(findRangeTextForId(text, '1')).toBe('{==highlighted==}{>>comment<<}');
	});

	test('handles multi-line range text', () => {
		const text = '{#1}line one\nline two\nline three{/1}';
		expect(findRangeTextForId(text, '1')).toBe('line one\nline two\nline three');
	});

	test('returns correct range when multiple IDs exist', () => {
		const text = '{#1}first{/1} and {#2}second{/2}';
		expect(findRangeTextForId(text, '1')).toBe('first');
		expect(findRangeTextForId(text, '2')).toBe('second');
	});

	test('handles non-numeric IDs', () => {
		const text = '{#my-note}some text{/my-note}';
		expect(findRangeTextForId(text, 'my-note')).toBe('some text');
	});

	test('handles nested ranges', () => {
		const text = '{#outer}text {#inner}more text{/inner}{/outer}';
		expect(findRangeTextForId(text, 'outer')).toBe('text {#inner}more text{/inner}');
		expect(findRangeTextForId(text, 'inner')).toBe('more text');
	});
});

describe('stripCriticMarkup', () => {
	test('strips {==...==} keeping content', () => {
		expect(stripCriticMarkup('{==highlighted==}')).toBe('highlighted');
	});

	test('strips {>>...<<} removing content', () => {
		expect(stripCriticMarkup('{>>comment<<}')).toBe('');
	});

	test('strips {#id>>...<<} removing content', () => {
		expect(stripCriticMarkup('{#1>>alice: note<<}')).toBe('');
	});

	test('preserves an unmatched opener while stripping a later complete comment', () => {
		const input = 'before {>>unmatched {>>remove me<<} after';
		expect(stripCriticMarkup(input)).toBe('before {>>unmatched  after');
	});

	test('strips valid nested comments as one complete block', () => {
		const input = 'before {>>outer {>>inner<<} outer<<} after';
		expect(stripCriticMarkup(input)).toBe('before  after');
	});

	test('strips {#id} and {/id} markers', () => {
		expect(stripCriticMarkup('{#1}text{/1}')).toBe('text');
	});

	test('strips {++...++} keeping content', () => {
		expect(stripCriticMarkup('{++added++}')).toBe('added');
	});

	test('strips {--...--} keeping content', () => {
		expect(stripCriticMarkup('{--deleted--}')).toBe('deleted');
	});

	test('strips {~~...~~} keeping content', () => {
		expect(stripCriticMarkup('{~~old~>new~~}')).toBe('old~>new');
	});

	test('handles combined inline comment with highlight', () => {
		expect(stripCriticMarkup('{==highlighted text==}{>>alice: comment<<}')).toBe('highlighted text');
	});

	test('handles text with no markup', () => {
		expect(stripCriticMarkup('plain text')).toBe('plain text');
	});

	test('handles empty string', () => {
		expect(stripCriticMarkup('')).toBe('');
	});

	test('strips nested ID ranges', () => {
		const input = '{#outer}text {#inner}more{/inner} end{/outer}';
		expect(stripCriticMarkup(input)).toBe('text more end');
	});

	test('strips multiple markup types in one text', () => {
		const input = '{==bold==} and {++added++} and {--removed--} and {>>comment<<}';
		expect(stripCriticMarkup(input)).toBe('bold and added and removed and');
	});

	test('trims whitespace', () => {
		expect(stripCriticMarkup('  hello  ')).toBe('hello');
	});
});

describe('comments without their closers', () => {
	// stripCriticMarkup as it was, which searched the text as it was after
	// each comment it took out for the next comment's <<}
	const stripCriticMarkupReference = (text: string): string => {
		let result = text;
		const openRe = /\{(?:>>|#[a-zA-Z0-9_-]+>>)/g;
		let match: RegExpExecArray | null;
		while ((match = openRe.exec(result)) !== null) {
			const closeIdx = findMatchingClose(result, match.index + match[0].length);
			if (closeIdx === -1) continue;
			result = result.slice(0, match.index) + result.slice(closeIdx + 3);
			openRe.lastIndex = match.index;
		}
		return result.replace(/\{#[a-zA-Z0-9_-]+\}/g, '').replace(/\{\/[a-zA-Z0-9_-]+\}/g, '')
			.replace(/\{==([\s\S]*?)==\}/g, '$1').replace(/\{\+\+([\s\S]*?)\+\+\}/g, '$1')
			.replace(/\{--([\s\S]*?)--\}/g, '$1').replace(/\{~~([\s\S]*?)~~\}/g, '$1').trim();
	};

	test('strips what it did', () => {
		const pieces = ['{>>', '<<}', '{#a>>', '{#', '>>', '<<', '{', '}', '{++', '++}', 'a', ' '];
		fc.assert(fc.property(fc.array(fc.constantFrom(...pieces), { maxLength: 30 }), parts => {
			const text = parts.join('');
			expect(stripCriticMarkup(text)).toBe(stripCriticMarkupReference(text));
		}), { numRuns: 1000 });
	});

	// Each comment's opener searched the rest of the text for its matching
	// <<} again where none was, so a text of many took time in the square of
	// their number. Each run reads its text 20 times, so the smaller one
	// takes about 20 ms and the timer's noise on a slower runner doesn't
	// decide the ratio. Longer texts don't do as well: the map of each
	// comment's closer outgrows the processor's cache, which alone takes
	// time faster than its size grows
	test.each([
		['finds the comment at an offset', (text: string) => expect(findCommentIdAtOffset(text, 0)).toBeUndefined()],
		['strips CriticMarkup', (text: string) => expect(stripCriticMarkup(text)).toBe(text.trim())],
	])('%s in time linear in their number', (_name, read) => {
		const time = (n: number) => {
			const text = 'x {>> a {#a>> b '.repeat(n);
			return fastestRun(() => {
				for (let k = 0; k < 20; k++) read(text);
			});
		};
		time(10000);
		const small = time(10000);
		expect(time(40000) / small).toBeLessThan(8);
	}, 60000);

	test('unwraps the spans it did', () => {
		const pieces = ['{>>', '<<}', '{#a>>', '{==', '==}', '{++', '++}', '{--', '--}', '{~~', '~~}', '~>', '{', '}', '=', '+', '-', '~', 'a', ' ', '\n'];
		fc.assert(fc.property(fc.array(fc.constantFrom(...pieces), { maxLength: 30 }), parts => {
			const text = parts.join('');
			expect(stripCriticMarkup(text)).toBe(stripCriticMarkupReference(text));
		}), { numRuns: 1000 });
	});

	test('strips spans without their closers in time linear in their number', () => {
		// Each lazy regex that unwrapped a kind of span read the rest of the
		// text again from each of its openers without a closer. Among spans
		// it unwraps, so the time is long enough that the timer's noise
		// doesn't decide the ratio
		const time = (n: number) => {
			const text = ('{++a++} '.repeat(500) + '{-- b ').repeat(n);
			return fastestRun(() => expect(stripCriticMarkup(text)).toBe(text.replaceAll('{++a++}', 'a').trim()));
		};
		time(750);
		const small = time(750);
		expect(time(3000) / small).toBeLessThan(8);
	}, 60000);
});
