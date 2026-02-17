import { describe, test, expect } from 'bun:test';
import { getCslCompletionContext, getCslFieldInfo, shouldAutoTriggerSuggestFromChanges } from './csl-language';
import { isCslAvailable } from '../csl-loader';

describe('getCslCompletionContext', () => {
	test('returns context when cursor is after "csl: " in frontmatter', () => {
		const text = '---\ncsl: apa\n---\n\nBody text.';
		const offset = text.indexOf('apa') + 3; // end of "apa"
		const ctx = getCslCompletionContext(text, offset);
		expect(ctx).toBeDefined();
		expect(ctx!.prefix).toBe('apa');
	});

	test('returns context with empty prefix when cursor is right after "csl: "', () => {
		const text = '---\ncsl: \n---\n\nBody text.';
		const offset = text.indexOf('csl: ') + 5;
		const ctx = getCslCompletionContext(text, offset);
		expect(ctx).toBeDefined();
		expect(ctx!.prefix).toBe('');
	});

	test('returns context when cursor is after "csl:" with no space', () => {
		const text = '---\ncsl:\n---\n\nBody text.';
		const offset = text.indexOf('csl:') + 4;
		const ctx = getCslCompletionContext(text, offset);
		expect(ctx).toBeDefined();
		expect(ctx!.prefix).toBe('');
	});

	test('returns context with partial prefix', () => {
		const text = '---\ncsl: chi\n---\n\nBody text.';
		const offset = text.indexOf('chi') + 3;
		const ctx = getCslCompletionContext(text, offset);
		expect(ctx).toBeDefined();
		expect(ctx!.prefix).toBe('chi');
	});

	test('returns undefined when cursor is outside frontmatter', () => {
		const text = '---\ncsl: apa\n---\n\ncsl: apa';
		const offset = text.lastIndexOf('csl: apa') + 5;
		const ctx = getCslCompletionContext(text, offset);
		expect(ctx).toBeUndefined();
	});

	test('returns undefined on other YAML keys', () => {
		const text = '---\ntitle: My Paper\ncsl: apa\n---\n';
		const offset = text.indexOf('My Paper') + 3;
		const ctx = getCslCompletionContext(text, offset);
		expect(ctx).toBeUndefined();
	});

	test('returns undefined when no frontmatter exists', () => {
		const text = 'Just a plain document.\ncsl: apa';
		const ctx = getCslCompletionContext(text, 10);
		expect(ctx).toBeUndefined();
	});

	test('provides correct valueStart and valueEnd', () => {
		const text = '---\ncsl: chicago-author-date\n---\n';
		const valueStartExpected = text.indexOf('chicago-author-date');
		const offset = valueStartExpected + 5;
		const ctx = getCslCompletionContext(text, offset);
		expect(ctx).toBeDefined();
		expect(ctx!.valueStart).toBe(valueStartExpected);
	});

	test('works with \\r\\n line endings', () => {
		const text = '---\r\ncsl: apa\r\n---\r\n\r\nBody text.';
		const offset = text.indexOf('apa') + 3;
		const ctx = getCslCompletionContext(text, offset);
		expect(ctx).toBeDefined();
		expect(ctx!.prefix).toBe('apa');
		// valueEnd should not include \r
		expect(text.slice(ctx!.valueStart, ctx!.valueEnd)).toBe('apa');
	});

	test('works with \\r\\n and no value', () => {
		const text = '---\r\ncsl:\r\n---\r\n';
		const offset = text.indexOf('csl:') + 4;
		const ctx = getCslCompletionContext(text, offset);
		expect(ctx).toBeDefined();
		expect(ctx!.prefix).toBe('');
		// valueStart should equal offset (cursor right after colon)
		expect(ctx!.valueStart).toBe(offset);
	});

	test('works with \\r\\n and multiple fields', () => {
		const text = '---\r\ntitle: Paper\r\ncsl: nature\r\n---\r\n';
		const offset = text.indexOf('nature') + 6;
		const ctx = getCslCompletionContext(text, offset);
		expect(ctx).toBeDefined();
		expect(ctx!.prefix).toBe('nature');
	});
});

describe('getCslFieldInfo', () => {
	test('extracts style name and range from frontmatter', () => {
		const text = '---\ncsl: apa\n---\n\nBody.';
		const info = getCslFieldInfo(text);
		expect(info).toBeDefined();
		expect(info!.value).toBe('apa');
		expect(text.slice(info!.valueStart, info!.valueEnd)).toBe('apa');
	});

	test('returns undefined when no frontmatter exists', () => {
		const text = 'Just a plain document.';
		expect(getCslFieldInfo(text)).toBeUndefined();
	});

	test('returns undefined when frontmatter has no csl field', () => {
		const text = '---\ntitle: My Paper\n---\n\nBody.';
		expect(getCslFieldInfo(text)).toBeUndefined();
	});

	test('handles empty csl value', () => {
		const text = '---\ncsl:\n---\n';
		const info = getCslFieldInfo(text);
		expect(info).toBeDefined();
		expect(info!.value).toBe('');
	});

	test('handles quoted values (double quotes)', () => {
		const text = '---\ncsl: "apa"\n---\n';
		const info = getCslFieldInfo(text);
		expect(info).toBeDefined();
		expect(info!.value).toBe('apa');
	});

	test('handles quoted values (single quotes)', () => {
		const text = "---\ncsl: 'apa'\n---\n";
		const info = getCslFieldInfo(text);
		expect(info).toBeDefined();
		expect(info!.value).toBe('apa');
	});

	test('handles csl field among other fields', () => {
		const text = '---\ntitle: Paper\ncsl: nature\nbibliography: refs.bib\n---\n';
		const info = getCslFieldInfo(text);
		expect(info).toBeDefined();
		expect(info!.value).toBe('nature');
	});

	test('works with \\r\\n line endings', () => {
		const text = '---\r\ncsl: apa\r\n---\r\n\r\nBody.';
		const info = getCslFieldInfo(text);
		expect(info).toBeDefined();
		expect(info!.value).toBe('apa');
		expect(text.slice(info!.valueStart, info!.valueEnd)).toBe('apa');
	});

	test('works with \\r\\n and multiple fields', () => {
		const text = '---\r\ntitle: Paper\r\ncsl: nature\r\nbibliography: refs.bib\r\n---\r\n';
		const info = getCslFieldInfo(text);
		expect(info).toBeDefined();
		expect(info!.value).toBe('nature');
		expect(text.slice(info!.valueStart, info!.valueEnd)).toBe('nature');
	});

	test('works with \\r\\n and empty value', () => {
		const text = '---\r\ncsl:\r\n---\r\n';
		const info = getCslFieldInfo(text);
		expect(info).toBeDefined();
		expect(info!.value).toBe('');
	});
});

describe('isCslAvailable', () => {
	test('returns true for bundled style names', () => {
		expect(isCslAvailable('apa')).toBe(true);
		expect(isCslAvailable('chicago-author-date')).toBe(true);
		expect(isCslAvailable('nature')).toBe(true);
	});

	test('returns false for non-existent style names', () => {
		expect(isCslAvailable('nonexistent-style')).toBe(false);
		expect(isCslAvailable('apa-nonexistent')).toBe(false);
	});

	test('returns false for empty string', () => {
		expect(isCslAvailable('')).toBe(false);
	});
});

describe('shouldAutoTriggerSuggestFromChanges', () => {
	test('returns true for single-character insertion', () => {
		expect(shouldAutoTriggerSuggestFromChanges([
			{ rangeLength: 0, text: 'a' },
		])).toBe(true);
	});
	test('returns true for single-character backspace', () => {
		expect(shouldAutoTriggerSuggestFromChanges([
			{ rangeLength: 1, text: '' },
		])).toBe(true);
	});
	test('returns false for completion acceptance replacement edit', () => {
		expect(shouldAutoTriggerSuggestFromChanges([
			{ rangeLength: 3, text: 'apa' },
		])).toBe(false);
	});
	test('returns false for multi-character paste', () => {
		expect(shouldAutoTriggerSuggestFromChanges([
			{ rangeLength: 0, text: 'apa' },
		])).toBe(false);
	});
	test('returns false for empty changes', () => {
		expect(shouldAutoTriggerSuggestFromChanges([])).toBe(false);
	});
});
