import { describe, expect, it } from 'bun:test';
import { isMarkdownPreviewViewType, matchPreviewTabLabel } from './preview-source';

const doc = (path: string) => ({ path });

describe('matchPreviewTabLabel', () => {
  it('finds the document an unlocked or locked preview names', () => {
    const a = doc('/w/paper.md');
    const b = doc('/w/notes.md');
    expect(matchPreviewTabLabel('Preview paper.md', [a, b])).toBe(a);
    expect(matchPreviewTabLabel('[Preview] notes.md', [a, b])).toBe(b);
  });

  it('gives none where two documents share the basename', () => {
    expect(matchPreviewTabLabel('Preview notes.md', [doc('/w/a/notes.md'), doc('/w/b/notes.md')])).toBeUndefined();
  });

  it('gives none where no document matches or the label is not English', () => {
    const a = doc('/w/paper.md');
    expect(matchPreviewTabLabel('Preview other.md', [a])).toBeUndefined();
    expect(matchPreviewTabLabel('Vorschau paper.md', [a])).toBeUndefined();
  });

  it('matches the whole basename, not its end', () => {
    expect(matchPreviewTabLabel('Preview data.md', [doc('/w/a.md'), doc('/w/my data.md')])).toBeUndefined();
    const d = doc('/w/data.md');
    expect(matchPreviewTabLabel('Preview data.md', [doc('/w/a.md'), d])).toBe(d);
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
