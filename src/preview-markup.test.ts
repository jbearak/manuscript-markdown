import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { PREVIEW_MARKUP_VIEWS, parsePreviewMarkup, previewMarkupPickItems } from './preview-markup';

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
const contributes = packageJson.contributes;
const setting = contributes.configuration.properties
  ? contributes.configuration.properties['manuscriptMarkdown.previewMarkup']
  : contributes.configuration.find((section: any) => section.properties?.['manuscriptMarkdown.previewMarkup'])
    .properties['manuscriptMarkdown.previewMarkup'];

describe('preview markup views', () => {
  it('reads a view the setting names, else all markup', () => {
    for (const view of PREVIEW_MARKUP_VIEWS) expect(parsePreviewMarkup(view.value)).toBe(view.value);
    expect(parsePreviewMarkup(undefined)).toBe('all');
    expect(parsePreviewMarkup('bogus')).toBe('all');
  });

  it('checks the current view in the picker, and only it', () => {
    const items = previewMarkupPickItems('simple');
    expect(items.map(item => item.label)).toEqual([
      '$(blank) All Markup',
      '$(check) Simple Markup',
      '$(blank) No Markup',
      '$(blank) Original',
    ]);
  });

  it('lists the setting\'s values and labels as the views, in order', () => {
    expect(setting.enum).toEqual(PREVIEW_MARKUP_VIEWS.map(view => view.value));
    expect(setting.enumItemLabels).toEqual(PREVIEW_MARKUP_VIEWS.map(view => view.label));
  });

  it('has a title bar button for each view, shown only in a preview with that view, and hidden from the palette', () => {
    const buttons = contributes.menus['editor/title'].filter((entry: any) =>
      entry.command?.startsWith('manuscript-markdown.choosePreviewMarkup.'));
    expect(buttons.map((entry: any) => entry.command)).toEqual(
      PREVIEW_MARKUP_VIEWS.map(view => 'manuscript-markdown.choosePreviewMarkup.' + view.value));
    for (const entry of buttons) expect(entry.when).toContain("activeWebviewPanelId == 'markdown.preview'");
    const hidden = contributes.menus.commandPalette
      .filter((entry: any) => entry.when === 'false')
      .map((entry: any) => entry.command);
    for (const view of PREVIEW_MARKUP_VIEWS) {
      const id = 'manuscript-markdown.choosePreviewMarkup.' + view.value;
      expect(hidden).toContain(id);
      expect(contributes.commands.find((command: any) => command.command === id)?.icon).toBeDefined();
    }
  });

  it('shows exactly one button for each setting value, and all markup\'s for one that names none', () => {
    const shown = (value: string) => contributes.menus['editor/title']
      .filter((entry: any) => entry.command?.startsWith('manuscript-markdown.choosePreviewMarkup.'))
      .filter((entry: any) => {
        const condition = entry.when.slice(entry.when.indexOf(') && ') + ') && '.length);
        return condition.split(' && ').every((clause: string) => {
          const [, op, want] = clause.match(/^config\.manuscriptMarkdown\.previewMarkup (==|!=) '(\w+)'$/)!;
          return op === '==' ? value === want : value !== want;
        });
      })
      .map((entry: any) => entry.command.split('.').pop());
    for (const view of PREVIEW_MARKUP_VIEWS) expect(shown(view.value)).toEqual([view.value]);
    expect(shown('bogus')).toEqual(['all']);
  });
});
