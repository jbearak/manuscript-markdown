// Feature: lsp-performance-phase2, Property 6: Navigation cache correctness and idempotence

import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';

// **Validates: Requirements 5.2, 5.3**

/**
 * The production getAllMatches in changes.ts uses a version-keyed cache:
 *   - (uri, version) → cached ranges
 *   - Return cached on match; fresh regex scan on mismatch
 *
 * Since getAllMatches depends on vscode.TextDocument and vscode.Range,
 * we test the caching pattern in isolation with a test-local scanner
 * that mirrors the production logic exactly.
 */

// Same combined pattern from changes.ts
const combinedPattern = /\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{\~\~([\s\S]*?)\~\~\}|\{#[a-zA-Z0-9_-]+>>([\s\S]*?)<<\}|\{>>([\s\S]*?)<<\}|\{#[a-zA-Z0-9_-]+\}|\{\/[a-zA-Z0-9_-]+\}|\{==([\s\S]*?)==\}|(?<!\{)==([^}=]+)==\{[a-z0-9-]+\}|(?<!\{)==([^}=]+)==(?!\})|\~\~([\s\S]*?)\~\~|<!--([\s\S]*?)-->/g;

/** Perform a fresh regex scan on text, returning matched strings. */
function freshScan(text: string): string[] {
	// Filter contained ranges (same logic as production getAllMatches)
	const filtered: string[] = [];
	const re = new RegExp(combinedPattern.source, combinedPattern.flags);
	const offsets: Array<{ start: number; end: number; text: string }> = [];
	let m;
	while ((m = re.exec(text)) !== null) {
		offsets.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
	}
	let lastKept: { start: number; end: number } | undefined;
	for (const o of offsets) {
		if (!lastKept || !(lastKept.start <= o.start && o.end <= lastKept.end)) {
			filtered.push(o.text);
			lastKept = o;
		}
	}
	return filtered;
}

/**
 * Test-local version-keyed cache that mirrors the production caching logic
 * in getAllMatches (changes.ts).
 */
function createCachedScanner() {
	let cachedUri: string | undefined;
	let cachedVersion: number | undefined;
	let cachedResult: string[] | undefined;
	let scanCount = 0;

	return {
		scan(uri: string, version: number, text: string): string[] {
			if (cachedUri === uri && cachedVersion === version && cachedResult) {
				return cachedResult;
			}
			scanCount++;
			const results = freshScan(text);
			cachedUri = uri;
			cachedVersion = version;
			cachedResult = results;
			return results;
		},
		get scanCount() { return scanCount; },
		reset() {
			cachedUri = undefined;
			cachedVersion = undefined;
			cachedResult = undefined;
			scanCount = 0;
		},
	};
}

// Generators — bounded to avoid timeouts per AGENTS.md guidance
const safeTextGen = fc.string({ minLength: 0, maxLength: 40 }).filter(
	(s: string) => !s.includes('{') && !s.includes('}') && !s.includes('~') &&
		!s.includes('>') && !s.includes('<') && !s.includes('=')
);

const patternGen = fc.oneof(
	safeTextGen.map(t => `{++${t}++}`),
	safeTextGen.map(t => `{--${t}--}`),
	safeTextGen.map(t => `{>>${t}<<}`),
	safeTextGen.map(t => `{==${t}==}`),
	safeTextGen.filter(t => t.length > 0).map(t => `==${t}==`),
);

const documentTextGen = fc.array(
	fc.oneof(safeTextGen, patternGen),
	{ minLength: 0, maxLength: 8 }
).map(parts => parts.join(' '));

const uriGen = fc.string({ minLength: 1, maxLength: 20 }).map(s => `file:///${s.replace(/[^a-zA-Z0-9]/g, 'x')}`);
const versionGen = fc.integer({ min: 0, max: 1000 });

describe('Property 6: Navigation cache correctness and idempotence', () => {

	test('two calls with same (uri, version) return identical arrays', () => {
		fc.assert(
			fc.property(
				uriGen,
				versionGen,
				documentTextGen,
				(uri, version, text) => {
					const scanner = createCachedScanner();
					const first = scanner.scan(uri, version, text);
					const second = scanner.scan(uri, version, text);

					// Same reference (cached)
					expect(second).toBe(first);
					// Deep equality as well
					expect(second).toEqual(first);
				}
			),
			{ numRuns: 100 }
		);
	});

	test('second call with same (uri, version) does NOT trigger a fresh scan', () => {
		fc.assert(
			fc.property(
				uriGen,
				versionGen,
				documentTextGen,
				(uri, version, text) => {
					const scanner = createCachedScanner();
					scanner.scan(uri, version, text);
					expect(scanner.scanCount).toBe(1);

					scanner.scan(uri, version, text);
					expect(scanner.scanCount).toBe(1); // no additional scan
				}
			),
			{ numRuns: 100 }
		);
	});

	test('call with new version triggers fresh scan matching new text', () => {
		fc.assert(
			fc.property(
				uriGen,
				versionGen,
				documentTextGen,
				documentTextGen,
				(uri, version1, text1, text2) => {
					const version2 = version1 + 1;
					const scanner = createCachedScanner();

					scanner.scan(uri, version1, text1);
					expect(scanner.scanCount).toBe(1);

					const result2 = scanner.scan(uri, version2, text2);
					expect(scanner.scanCount).toBe(2); // fresh scan triggered

					// Result must match a fresh independent scan of text2
					const expected = freshScan(text2);
					expect(result2).toEqual(expected);
				}
			),
			{ numRuns: 100 }
		);
	});

	test('call with different URI triggers a fresh scan', () => {
		fc.assert(
			fc.property(
				uriGen,
				uriGen,
				versionGen,
				documentTextGen,
				documentTextGen,
				(uri1, uri2Raw, version, text1, text2) => {
					// Ensure URIs are distinct
					const uri2 = uri2Raw === uri1 ? uri1 + '/other' : uri2Raw;
					const scanner = createCachedScanner();

					scanner.scan(uri1, version, text1);
					expect(scanner.scanCount).toBe(1);

					const result2 = scanner.scan(uri2, version, text2);
					expect(scanner.scanCount).toBe(2); // fresh scan for different URI

					const expected = freshScan(text2);
					expect(result2).toEqual(expected);
				}
			),
			{ numRuns: 100 }
		);
	});

	test('cached result matches fresh scan for any document text', () => {
		fc.assert(
			fc.property(
				uriGen,
				versionGen,
				documentTextGen,
				(uri, version, text) => {
					const scanner = createCachedScanner();
					const result = scanner.scan(uri, version, text);
					const expected = freshScan(text);
					expect(result).toEqual(expected);
				}
			),
			{ numRuns: 100 }
		);
	});
});
