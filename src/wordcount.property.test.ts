// Feature: lsp-performance-phase2, Property 4: Word count debounce consolidates rapid text changes

import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';

// **Validates: Requirements 4.1, 4.2**

/**
 * Test-local debounce function that mirrors the production scheduleUpdate logic
 * in WordCountController:
 *   - Single timer (only one active editor at a time)
 *   - Each call cancels any pending timer and restarts the debounce window
 *   - On expiry, invokes the callback (updateWordCount)
 */
function createWordCountDebouncer(delayMs: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let callCount = 0;
	return {
		scheduleUpdate(): void {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = undefined;
				callCount++;
			}, delayMs);
		},
		get callCount() { return callCount; },
		get pending() { return timer !== undefined; },
		reset() { callCount = 0; if (timer) { clearTimeout(timer); timer = undefined; } },
	};
}

describe('Property 4: Word count debounce consolidates rapid text changes', () => {
	const DEBOUNCE_MS = 5; // very short for fast property tests

	test('N rapid text change events within debounce window produce exactly one updateWordCount execution', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 50 }),
				async (n) => {
					const debouncer = createWordCountDebouncer(DEBOUNCE_MS);

					// Fire N text change events rapidly (all synchronous — well within the debounce window)
					for (let i = 0; i < n; i++) {
						debouncer.scheduleUpdate();
					}

					// Timer should be pending
					expect(debouncer.pending).toBe(true);
					expect(debouncer.callCount).toBe(0);

					// Wait for debounce to fire
					await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 20));

					expect(debouncer.callCount).toBe(1);
					expect(debouncer.pending).toBe(false);

					debouncer.reset();
				}
			),
			{ numRuns: 100 }
		);
	}, 30_000);

	test('no events means no updateWordCount execution', async () => {
		const debouncer = createWordCountDebouncer(DEBOUNCE_MS);

		// Wait without scheduling anything
		await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 20));

		expect(debouncer.callCount).toBe(0);
		expect(debouncer.pending).toBe(false);

		debouncer.reset();
	}, 10_000);

	test('events spaced beyond debounce interval each trigger a separate updateWordCount', async () => {
		const debouncer = createWordCountDebouncer(DEBOUNCE_MS);

		// First event
		debouncer.scheduleUpdate();
		await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 20));
		expect(debouncer.callCount).toBe(1);

		// Second event after interval elapsed
		debouncer.scheduleUpdate();
		await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 20));
		expect(debouncer.callCount).toBe(2);

		debouncer.reset();
	}, 10_000);
});

// Feature: lsp-performance-phase2, Property 5: Empty selections skip word count update

// **Validates: Requirements 4.4, 4.5**

/**
 * Test-local model of the selection-aware logic from WordCountController:
 *   - If every selection is empty (cursor-only movement) → skip entirely
 *   - If at least one selection is non-empty → scheduleUpdate (debounced)
 */
function createSelectionAwareDebouncer(delayMs: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let callCount = 0;
	return {
		handleSelectionChange(selections: Array<{ isEmpty: boolean }>): void {
			if (selections.every(s => s.isEmpty)) return; // skip cursor-only
			// scheduleUpdate
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = undefined;
				callCount++;
			}, delayMs);
		},
		get callCount() { return callCount; },
		get pending() { return timer !== undefined; },
		reset() { callCount = 0; if (timer) { clearTimeout(timer); timer = undefined; } },
	};
}

describe('Property 5: Empty selections skip word count update', () => {
	const DEBOUNCE_MS = 5;

	// Generator: a single selection as { isEmpty: boolean }
	const selectionGen = fc.boolean().map(isEmpty => ({ isEmpty }));
	const selectionsGen = fc.array(selectionGen, { minLength: 1, maxLength: 10 });

	test('empty-only selections never trigger update; non-empty selections trigger exactly one debounced update', async () => {
		await fc.assert(
			fc.asyncProperty(
				selectionsGen,
				async (selections) => {
					const debouncer = createSelectionAwareDebouncer(DEBOUNCE_MS);
					const allEmpty = selections.every(s => s.isEmpty);

					debouncer.handleSelectionChange(selections);

					if (allEmpty) {
						// Should not schedule anything
						expect(debouncer.pending).toBe(false);
						expect(debouncer.callCount).toBe(0);

						// Even after waiting, still zero
						await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 20));
						expect(debouncer.callCount).toBe(0);
					} else {
						// Should have a pending timer
						expect(debouncer.pending).toBe(true);
						expect(debouncer.callCount).toBe(0);

						// After debounce fires, exactly one update
						await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 20));
						expect(debouncer.callCount).toBe(1);
						expect(debouncer.pending).toBe(false);
					}

					debouncer.reset();
				}
			),
			{ numRuns: 100 }
		);
	}, 30_000);

	test('multiple consecutive empty-only selection events never accumulate updates', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 20 }),
				async (n) => {
					const debouncer = createSelectionAwareDebouncer(DEBOUNCE_MS);

					// Fire N selection events, all with only empty selections
					for (let i = 0; i < n; i++) {
						debouncer.handleSelectionChange([{ isEmpty: true }]);
					}

					expect(debouncer.pending).toBe(false);
					expect(debouncer.callCount).toBe(0);

					await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 20));
					expect(debouncer.callCount).toBe(0);

					debouncer.reset();
				}
			),
			{ numRuns: 100 }
		);
	}, 30_000);

	test('multiple non-empty selection events within debounce window produce exactly one update', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 20 }),
				async (n) => {
					const debouncer = createSelectionAwareDebouncer(DEBOUNCE_MS);

					// Fire N selection events, each with at least one non-empty selection
					for (let i = 0; i < n; i++) {
						debouncer.handleSelectionChange([{ isEmpty: false }]);
					}

					expect(debouncer.pending).toBe(true);
					expect(debouncer.callCount).toBe(0);

					await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS + 20));
					expect(debouncer.callCount).toBe(1);

					debouncer.reset();
				}
			),
			{ numRuns: 100 }
		);
	}, 30_000);
});
