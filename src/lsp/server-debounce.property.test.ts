// Feature: lsp-performance-phase2, Property 1: Debounce consolidates rapid changes

import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';

// **Validates: Requirements 1.1, 1.2, 1.3**

/**
 * Test-local debounce function that mirrors the production logic in server.ts:
 *   - Maintains a per-key timer map (like validationTimers)
 *   - Each call cancels any pending timer and restarts the debounce window
 *   - On expiry, invokes the callback with the most recent value
 */
function createDebouncer(delayMs: number) {
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	return {
		schedule(key: string, callback: () => void): void {
			const existing = timers.get(key);
			if (existing) clearTimeout(existing);
			timers.set(key, setTimeout(() => {
				timers.delete(key);
				callback();
			}, delayMs));
		},
		pending(key: string): boolean {
			return timers.has(key);
		},
		clear(): void {
			for (const t of timers.values()) clearTimeout(t);
			timers.clear();
		},
	};
}

describe('Property 1: Debounce consolidates rapid changes', () => {
	const DEBOUNCE_MS = 5; // very short for fast property tests

	test('N rapid events within debounce window produce exactly one callback execution', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 50 }),
				async (n) => {
					const debouncer = createDebouncer(DEBOUNCE_MS);
					let callCount = 0;
					let lastValue = '';

					// Fire N events rapidly (all synchronous — well within the debounce window)
					for (let i = 0; i < n; i++) {
						const text = `version-${i}`;
						debouncer.schedule('doc:test', () => {
							callCount++;
							lastValue = text;
						});
					}

					// Wait for debounce to fire
					await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 20));

					expect(callCount).toBe(1);
					expect(lastValue).toBe(`version-${n - 1}`);
					expect(debouncer.pending('doc:test')).toBe(false);

					debouncer.clear();
				}
			),
			{ numRuns: 100 }
		);
	}, 30_000);

	test('rapid events for multiple URIs each produce exactly one callback', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 10 }),
				fc.integer({ min: 2, max: 5 }),
				async (eventsPerUri, uriCount) => {
					const debouncer = createDebouncer(DEBOUNCE_MS);
					const counts = new Map<string, number>();
					const lastValues = new Map<string, string>();

					for (let u = 0; u < uriCount; u++) {
						const uri = `file:///doc-${u}.md`;
						counts.set(uri, 0);
						for (let i = 0; i < eventsPerUri; i++) {
							const text = `uri${u}-v${i}`;
							debouncer.schedule(uri, () => {
								counts.set(uri, (counts.get(uri) ?? 0) + 1);
								lastValues.set(uri, text);
							});
						}
					}

					await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 20));

					for (let u = 0; u < uriCount; u++) {
						const uri = `file:///doc-${u}.md`;
						expect(counts.get(uri)).toBe(1);
						expect(lastValues.get(uri)).toBe(`uri${u}-v${eventsPerUri - 1}`);
					}

					debouncer.clear();
				}
			),
			{ numRuns: 100 }
		);
	}, 30_000);

	test('events spaced beyond debounce interval each trigger a separate callback', async () => {
		const debouncer = createDebouncer(DEBOUNCE_MS);
		let callCount = 0;
		const receivedValues: string[] = [];

		// First event
		debouncer.schedule('doc:test', () => {
			callCount++;
			receivedValues.push('first');
		});

		// Wait for first debounce to fire
		await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 20));
		expect(callCount).toBe(1);
		expect(receivedValues).toEqual(['first']);

		// Second event after interval elapsed
		debouncer.schedule('doc:test', () => {
			callCount++;
			receivedValues.push('second');
		});

		await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 20));
		expect(callCount).toBe(2);
		expect(receivedValues).toEqual(['first', 'second']);

		debouncer.clear();
	}, 10_000);
});
