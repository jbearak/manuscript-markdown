import { describe, test, expect, beforeEach } from 'bun:test';

// Test the bib reverse map data structure logic directly
// (mirrors the implementation in server.ts)

const bibReverseMap = new Map<string, Set<string>>();

function removeBibReverseMapEntry(docUri: string): void {
  for (const [, uris] of bibReverseMap) {
    uris.delete(docUri);
  }
}

function updateBibReverseMap(docUri: string, canonicalBibPath: string | undefined): void {
  removeBibReverseMapEntry(docUri);
  if (canonicalBibPath) {
    if (!bibReverseMap.has(canonicalBibPath)) {
      bibReverseMap.set(canonicalBibPath, new Set());
    }
    bibReverseMap.get(canonicalBibPath)!.add(docUri);
  }
}

function getMarkdownUrisForBib(canonicalBibPath: string): Set<string> {
  return bibReverseMap.get(canonicalBibPath) ?? new Set();
}

describe('Bib Reverse Map', () => {
  beforeEach(() => {
    bibReverseMap.clear();
  });

  test('add document to reverse map', () => {
    updateBibReverseMap('file:///doc.md', '/canonical/refs.bib');
    expect(getMarkdownUrisForBib('/canonical/refs.bib').has('file:///doc.md')).toBe(true);
  });

  test('multiple docs for same bib', () => {
    updateBibReverseMap('file:///a.md', '/canonical/refs.bib');
    updateBibReverseMap('file:///b.md', '/canonical/refs.bib');
    const uris = getMarkdownUrisForBib('/canonical/refs.bib');
    expect(uris.size).toBe(2);
    expect(uris.has('file:///a.md')).toBe(true);
    expect(uris.has('file:///b.md')).toBe(true);
  });

  test('update moves doc to new bib', () => {
    updateBibReverseMap('file:///doc.md', '/canonical/old.bib');
    updateBibReverseMap('file:///doc.md', '/canonical/new.bib');
    expect(getMarkdownUrisForBib('/canonical/old.bib').has('file:///doc.md')).toBe(false);
    expect(getMarkdownUrisForBib('/canonical/new.bib').has('file:///doc.md')).toBe(true);
  });

  test('remove entry', () => {
    updateBibReverseMap('file:///doc.md', '/canonical/refs.bib');
    removeBibReverseMapEntry('file:///doc.md');
    expect(getMarkdownUrisForBib('/canonical/refs.bib').has('file:///doc.md')).toBe(false);
  });

  test('remove from multiple bibs', () => {
    // Simulate a doc that was associated with one bib, then another
    bibReverseMap.set('/bib1', new Set(['file:///doc.md']));
    bibReverseMap.set('/bib2', new Set(['file:///doc.md']));
    removeBibReverseMapEntry('file:///doc.md');
    expect(getMarkdownUrisForBib('/bib1').size).toBe(0);
    expect(getMarkdownUrisForBib('/bib2').size).toBe(0);
  });

  test('lookup nonexistent bib returns empty set', () => {
    expect(getMarkdownUrisForBib('/nonexistent.bib').size).toBe(0);
  });

  test('update with undefined bib removes from all', () => {
    updateBibReverseMap('file:///doc.md', '/canonical/refs.bib');
    updateBibReverseMap('file:///doc.md', undefined);
    expect(getMarkdownUrisForBib('/canonical/refs.bib').has('file:///doc.md')).toBe(false);
  });
});
