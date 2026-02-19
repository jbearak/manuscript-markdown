// Feature: lsp-performance-phase2, Property 2: LRU cache returns correct canonical paths

import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { LruCache } from './citekey-language';

// **Validates: Requirements 2.3**

describe('Property 2: LRU cache returns correct canonical paths', () => {
	const keyGen = fc.string({ minLength: 1, maxLength: 30 });
	const valueGen = fc.string({ minLength: 1, maxLength: 30 });

	test('cache size never exceeds maxSize after any sequence of operations', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 64 }),
				fc.array(
					fc.tuple(keyGen, valueGen),
					{ minLength: 1, maxLength: 500 }
				),
				(maxSize, entries) => {
					const cache = new LruCache<string, string>(maxSize);
					for (const [k, v] of entries) {
						cache.set(k, v);
						expect(cache.size).toBeLessThanOrEqual(maxSize);
					}
				}
			),
			{ numRuns: 200 }
		);
	});

	test('cache size stays at maxSize after >maxSize distinct inserts', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 50 }),
				(maxSize) => {
					const cache = new LruCache<string, string>(maxSize);
					const count = maxSize + 100;
					for (let i = 0; i < count; i++) {
						cache.set(`key-${i}`, `val-${i}`);
					}
					expect(cache.size).toBe(maxSize);
				}
			),
			{ numRuns: 100 }
		);
	});

	test('get returns the most recently set value for a key', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 64 }),
				keyGen,
				fc.array(valueGen, { minLength: 1, maxLength: 20 }),
				(maxSize, key, values) => {
					const cache = new LruCache<string, string>(maxSize);
					for (const v of values) {
						cache.set(key, v);
					}
					expect(cache.get(key)).toBe(values[values.length - 1]);
				}
			),
			{ numRuns: 200 }
		);
	});

	test('LRU eviction removes the least recently used entry', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 2, max: 32 }),
				(maxSize) => {
					const cache = new LruCache<string, string>(maxSize);

					// Fill cache to capacity
					for (let i = 0; i < maxSize; i++) {
						cache.set(`k${i}`, `v${i}`);
					}
					expect(cache.size).toBe(maxSize);

					// Access the first key to make it most-recently-used
					expect(cache.get('k0')).toBe('v0');

					// Insert one more to trigger eviction — k1 should be evicted (LRU)
					cache.set('new-key', 'new-val');
					expect(cache.size).toBe(maxSize);

					// k0 was accessed so it should survive; k1 was LRU and should be evicted
					expect(cache.get('k0')).toBe('v0');
					expect(cache.get('k1')).toBeUndefined();
					expect(cache.get('new-key')).toBe('new-val');
				}
			),
			{ numRuns: 100 }
		);
	});

	test('cache with maxSize 256 handles >256 distinct paths', () => {
		const cache = new LruCache<string, string>(256);
		for (let i = 0; i < 300; i++) {
			cache.set(`/path/to/file-${i}`, `/resolved/file-${i}`);
			expect(cache.size).toBeLessThanOrEqual(256);
		}
		expect(cache.size).toBe(256);

		// Earliest entries should be evicted
		expect(cache.get('/path/to/file-0')).toBeUndefined();
		expect(cache.get('/path/to/file-43')).toBeUndefined();

		// Latest entries should be present
		expect(cache.get('/path/to/file-299')).toBe('/resolved/file-299');
	});
});
