import { describe, expect, it } from 'bun:test';
import { focusGroupCommand, isMarkdownPreviewViewType, isStaticPreviewViewType, labelNamesStaticPreviewFile, pollFor, previewLabelNamesFile } from './preview-source';

describe('isMarkdownPreviewViewType', () => {
  it('accepts the preview viewType with or without VS Code\'s prefix', () => {
    expect(isMarkdownPreviewViewType('mainThreadWebview-markdown.preview')).toBe(true);
    expect(isMarkdownPreviewViewType('markdown.preview')).toBe(true);
    expect(isMarkdownPreviewViewType('mainThreadWebview-other.markdown.previewer')).toBe(false);
    expect(isMarkdownPreviewViewType('mainThreadWebview-foo.markdown.preview')).toBe(false);
  });
});

describe('isStaticPreviewViewType', () => {
  it('accepts the static preview\'s viewType as a custom editor\'s or a webview\'s, and not the dynamic preview\'s', () => {
    expect(isStaticPreviewViewType('vscode.markdown.preview.editor')).toBe(true);
    expect(isStaticPreviewViewType('mainThreadWebview-vscode.markdown.preview.editor')).toBe(true);
    expect(isStaticPreviewViewType('mainThreadWebview-markdown.preview')).toBe(false);
    expect(isStaticPreviewViewType('vscode.markdown.editor')).toBe(false);
  });
});

describe('labelNamesStaticPreviewFile', () => {
  it('finds a file the static preview opens in a diff\'s label or a plain one, and not in other tabs\' labels', () => {
    expect(labelNamesStaticPreviewFile('b.md ↔ c.md')).toBe(true);
    expect(labelNamesStaticPreviewFile('b.markdown ↔ c.markdown')).toBe(true);
    expect(labelNamesStaticPreviewFile('NOTES.MD')).toBe(true);
    expect(labelNamesStaticPreviewFile('Settings')).toBe(false);
    expect(labelNamesStaticPreviewFile('Welcome')).toBe(false);
    expect(labelNamesStaticPreviewFile('a.mdx')).toBe(false);
  });
});

describe('previewLabelNamesFile', () => {
  it('finds the file an unlocked, locked or localized preview names', () => {
    expect(previewLabelNamesFile('Preview paper.md', '/w/paper.md')).toBe(true);
    expect(previewLabelNamesFile('[Preview] paper.md', '/w/paper.md')).toBe(true);
    expect(previewLabelNamesFile('Vorschau my notes.md', '/w/my notes.md')).toBe(true);
    expect(previewLabelNamesFile('paper.md のプレビュー', '/w/paper.md')).toBe(true);
    expect(previewLabelNamesFile('Preview Untitled-1', 'Untitled-1')).toBe(true);
  });

  it('refuses another file, or one whose name only ends the title\'s', () => {
    expect(previewLabelNamesFile('Preview paper.md', '/w/notes.md')).toBe(false);
    expect(previewLabelNamesFile('Preview data.md', '/w/a.md')).toBe(false);
    expect(previewLabelNamesFile('Preview a.md.bak', '/w/a.md')).toBe(false);
    expect(previewLabelNamesFile('Preview a.md', '/w/')).toBe(false);
  });
});

describe('focusGroupCommand', () => {
  it('names VS Code\'s command for the first eight columns and none past them', () => {
    expect(focusGroupCommand(1)).toBe('workbench.action.focusFirstEditorGroup');
    expect(focusGroupCommand(2)).toBe('workbench.action.focusSecondEditorGroup');
    expect(focusGroupCommand(8)).toBe('workbench.action.focusEighthEditorGroup');
    expect(focusGroupCommand(9)).toBeUndefined();
    expect(focusGroupCommand(0)).toBeUndefined();
  });
});

describe('pollFor', () => {
  it('gives the first value once there is one', async () => {
    let calls = 0;
    expect(await pollFor(() => (++calls === 3 ? 'x' : undefined), 1000, 1)).toBe('x');
    expect(calls).toBe(3);
  });

  it('gives undefined once the time is up', async () => {
    expect(await pollFor(async () => undefined, 20, 5)).toBeUndefined();
  });
});
