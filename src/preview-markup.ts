// The preview's markup views, as Word's, and the picker that chooses one.
// The order here is the picker's, and the setting's enum in package.json
// lists the same values in it (see preview-markup.test.ts).
import type { PreviewMarkup } from './preview/manuscript-markdown-plugin';

export interface PreviewMarkupView {
  value: PreviewMarkup;
  label: string;
  description: string;
}

export const PREVIEW_MARKUP_VIEWS: readonly PreviewMarkupView[] = [
  { value: 'all', label: 'All Markup', description: 'Every change marked' },
  { value: 'simple', label: 'Simple Markup', description: 'Every change accepted, with a bar by each block that had one' },
  { value: 'none', label: 'No Markup', description: 'Every change accepted' },
  { value: 'original', label: 'Original', description: 'Every change rejected' },
];

/** The setting's value as a view, all markup for one that names none */
export function parsePreviewMarkup(value: unknown): PreviewMarkup {
  return PREVIEW_MARKUP_VIEWS.find(view => view.value === value)?.value ?? 'all';
}

/** The picker's items, the current view's checked; the others' blank icon
 *  keeps their labels in line with its */
export function previewMarkupPickItems(current: PreviewMarkup): Array<{ label: string; description: string; value: PreviewMarkup }> {
  return PREVIEW_MARKUP_VIEWS.map(view => ({
    label: (view.value === current ? '$(check) ' : '$(blank) ') + view.label,
    description: view.description,
    value: view.value,
  }));
}
