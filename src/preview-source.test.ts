import { describe, expect, it } from 'bun:test';
import { focusGroupCommand, isMarkdownPreviewViewType, pollFor } from './preview-source';

describe('isMarkdownPreviewViewType', () => {
  it('accepts the preview viewType with or without VS Code\'s prefix', () => {
    expect(isMarkdownPreviewViewType('mainThreadWebview-markdown.preview')).toBe(true);
    expect(isMarkdownPreviewViewType('markdown.preview')).toBe(true);
    expect(isMarkdownPreviewViewType('mainThreadWebview-other.markdown.previewer')).toBe(false);
    expect(isMarkdownPreviewViewType('mainThreadWebview-foo.markdown.preview')).toBe(false);
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
