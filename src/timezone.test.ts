import { describe, test, expect } from 'bun:test';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { formatLocalIsoMinute, getLocalTimezoneOffset } from './converter';
import { normalizeToUtcIso } from './md-to-docx';

describe('frontmatter timezone field', () => {
  test('parseFrontmatter extracts timezone', () => {
    const md = '---\ntimezone: -05:00\n---\nBody text';
    const { metadata, body } = parseFrontmatter(md);
    expect(metadata.timezone).toBe('-05:00');
    expect(body).toBe('Body text');
  });

  test('parseFrontmatter handles positive offset', () => {
    const { metadata } = parseFrontmatter('---\ntimezone: +09:30\n---\n');
    expect(metadata.timezone).toBe('+09:30');
  });

  test('parseFrontmatter handles UTC offset', () => {
    const { metadata } = parseFrontmatter('---\ntimezone: +00:00\n---\n');
    expect(metadata.timezone).toBe('+00:00');
  });

  test('parseFrontmatter with no timezone returns undefined', () => {
    const { metadata } = parseFrontmatter('---\ncsl: apa\n---\n');
    expect(metadata.timezone).toBeUndefined();
  });

  test('serializeFrontmatter includes timezone', () => {
    const result = serializeFrontmatter({ timezone: '-05:00' });
    expect(result).toBe('---\ntimezone: -05:00\n---\n');
  });

  test('serializeFrontmatter omits timezone when absent', () => {
    const result = serializeFrontmatter({ csl: 'apa' });
    expect(result).not.toContain('timezone');
  });

  test('serializeFrontmatter preserves timezone with other fields', () => {
    const result = serializeFrontmatter({ csl: 'apa', locale: 'en-US', timezone: '+01:00' });
    expect(result).toContain('timezone: +01:00');
    expect(result).toContain('csl: apa');
  });
});

describe('getLocalTimezoneOffset', () => {
  test('returns a valid UTC offset string', () => {
    const tz = getLocalTimezoneOffset();
    expect(tz).toMatch(/^[+-]\d{2}:\d{2}$/);
  });

  test('matches formatLocalIsoMinute offset', () => {
    const tz = getLocalTimezoneOffset();
    const formatted = formatLocalIsoMinute('2024-06-15T12:00:00Z');
    expect(formatted).toContain(tz);
  });
});

describe('normalizeToUtcIso', () => {
  test('converts ISO with Z to UTC', () => {
    expect(normalizeToUtcIso('2024-01-15T10:30:00Z')).toBe('2024-01-15T10:30:00Z');
  });

  test('converts ISO with positive offset to UTC', () => {
    expect(normalizeToUtcIso('2024-01-15T15:30+05:00')).toBe('2024-01-15T10:30:00Z');
  });

  test('converts ISO with negative offset to UTC', () => {
    expect(normalizeToUtcIso('2024-01-15T05:30-05:00')).toBe('2024-01-15T10:30:00Z');
  });

  test('uses fallback timezone for local dates', () => {
    expect(normalizeToUtcIso('2024-01-15T10:30', '-05:00')).toBe('2024-01-15T15:30:00Z');
  });

  test('uses fallback timezone for space-separated dates', () => {
    expect(normalizeToUtcIso('2024-01-15 10:30', '+03:00')).toBe('2024-01-15T07:30:00Z');
  });

  test('falls back to system local when no timezone info', () => {
    const result = normalizeToUtcIso('2024-01-15T10:30');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test('returns current time for empty string', () => {
    const before = Date.now();
    const result = normalizeToUtcIso('');
    const after = Date.now();
    const resultMs = new Date(result).getTime();
    expect(resultMs).toBeGreaterThanOrEqual(before - 1000);
    expect(resultMs).toBeLessThanOrEqual(after + 1000);
  });

  test('returns original for unparseable date', () => {
    expect(normalizeToUtcIso('not-a-date')).toBe('not-a-date');
  });

  test('strips milliseconds from output', () => {
    const result = normalizeToUtcIso('2024-01-15T10:30:00.123Z');
    expect(result).toBe('2024-01-15T10:30:00Z');
    expect(result).not.toContain('.123');
  });
});

describe('date roundtrip: formatLocalIsoMinute → normalizeToUtcIso', () => {
  test('UTC date survives roundtrip', () => {
    const utcDate = '2024-06-15T12:00:00Z';
    const localFormatted = formatLocalIsoMinute(utcDate);
    const backToUtc = normalizeToUtcIso(localFormatted);
    expect(backToUtc).toBe(utcDate);
  });

  test('multiple UTC dates survive roundtrip', () => {
    const dates = [
      '2024-01-01T00:00:00Z',
      '2024-06-15T12:30:00Z',
      '2024-12-31T23:59:00Z',
      '2025-03-10T08:15:00Z',
    ];
    for (const utcDate of dates) {
      const localFormatted = formatLocalIsoMinute(utcDate);
      const backToUtc = normalizeToUtcIso(localFormatted);
      expect(backToUtc).toBe(utcDate);
    }
  });
});
