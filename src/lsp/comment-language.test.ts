import { describe, test, expect } from 'bun:test';
import {
	findCommentIdAtOffset,
	findRangeTextForId,
	stripCriticMarkup,
} from './comment-language';

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
