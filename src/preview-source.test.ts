import { describe, expect, it } from 'bun:test';
import { isMarkdownPreviewViewType, matchPreviewTabLabel } from './preview-source';

const doc = (path: string, seq = 10) => ({ uri: { path }, seq });

describe('matchPreviewTabLabel', () => {
  it('finds the document an unlocked or locked preview names', () => {
    const a = doc('/w/paper.md');
    const b = doc('/w/notes.md');
    expect(matchPreviewTabLabel('Preview paper.md', 1, [a, b])).toBe(a.uri);
    expect(matchPreviewTabLabel('[Preview] notes.md', 1, [a, b])).toBe(b.uri);
  });

  it('gives none where two documents share the basename', () => {
    expect(matchPreviewTabLabel('Preview notes.md', 1, [doc('/w/a/notes.md'), doc('/w/b/notes.md')])).toBeUndefined();
  });

  it('gives none where no document matches or the label is not English', () => {
    const a = doc('/w/paper.md');
    expect(matchPreviewTabLabel('Preview other.md', 1, [a])).toBeUndefined();
    expect(matchPreviewTabLabel('Vorschau paper.md', 1, [a])).toBeUndefined();
  });

  it('matches the whole basename, not its end', () => {
    expect(matchPreviewTabLabel('Preview data.md', 1, [doc('/w/a.md'), doc('/w/my data.md')])).toBeUndefined();
    const d = doc('/w/data.md');
    expect(matchPreviewTabLabel('Preview data.md', 1, [doc('/w/a.md'), d])).toBe(d.uri);
  });

  it('gives none where the one document of that name rendered only before the label, as an older preview of another notes.md where the new one has not rendered yet', () => {
    expect(matchPreviewTabLabel('Preview notes.md', 5, [doc('/w/a/notes.md', 4)])).toBeUndefined();
    const b = doc('/w/b/notes.md', 6);
    expect(matchPreviewTabLabel('Preview notes.md', 5, [b])).toBe(b.uri);
  });
});

describe('isMarkdownPreviewViewType', () => {
  it('accepts the preview viewType with or without VS Code\'s prefix', () => {
    expect(isMarkdownPreviewViewType('mainThreadWebview-markdown.preview')).toBe(true);
    expect(isMarkdownPreviewViewType('markdown.preview')).toBe(true);
    expect(isMarkdownPreviewViewType('mainThreadWebview-other.markdown.previewer')).toBe(false);
    expect(isMarkdownPreviewViewType('mainThreadWebview-foo.markdown.preview')).toBe(false);
  });
});
