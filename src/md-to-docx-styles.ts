// styles.xml as export writes it, or a template's with the document's
// fonts, sizes, line spacing, alert colors and custom styles put in, and the
// defaults those start from. Split out of md-to-docx.ts, whose header's
// invariants hold here too.
import { type ColorScheme, Frontmatter } from './frontmatter';
import type { GfmAlertType } from './gfm';
import { LATENT_STYLES } from './latent-styles';
import type { MdRun } from './md-to-docx';
import { alertColorsByScheme, getDefaultColorScheme } from './alert-colors';
import { asUtf8, decodeXml } from './template-sections';
import { escapeXmlAttribute } from './xml-parser';
import { findStyleElement, styleFinder } from './style-element';
import { holdsXmlElement, otherXmlAttributes, replaceXmlElements, withXmlAttribute, xmlAttribute, xmlElement, xmlElementParts, xmlSearch, xmlStartTag, xmlStartTags } from './xml-elements';
import { orderPPr, orderRPr, textElements } from './md-to-docx-citations';
import { wordIgnoresStyle, xmlHalfPoints } from './converter';

// --- Font override resolution ---
// Default sizes in half-points for OOXML styles.
// Implementation note: bodySizeHp default (22hp = 11pt) is the scaling base
// for proportional heading computation.
const DEFAULT_BODY_HP = 22;
const DEFAULT_HEADING_SIZES_HP: Record<string, number> = {
  Heading1: 32,
  Heading2: 26,
  Heading3: 24,
  Heading4: 22,
  Heading5: 20,
  Heading6: 18,
  Title: 56,
  FootnoteText: 20,
  EndnoteText: 20,
};
const DEFAULT_CODE_BLOCK_HP = 20;
// Uniform padding (horizontal indent + vertical spacing) for code blocks, in twips (~8pt / 0.11in)
export const CODE_BLOCK_INSET_TWIPS = 160;
const DEFAULT_CODE_BACKGROUND = 'E8E8E8';
const DEFAULT_CODE_COLOR = '2E2E2E';
const DEFAULT_CODE_BORDER_SIZE = 48;
const CODE_BORDER_SPACE = 8;
export const GITHUB_BLOCKQUOTE_BORDER_SIZE = 18;
export const GITHUB_BLOCKQUOTE_BORDER_SPACE = 8;
export const GITHUB_BLOCKQUOTE_BORDER_COLOR = 'D0D7DE';
export const GITHUB_BLOCKQUOTE_INDENT = 240;
// Single-line spacing in OOXML (240 twips = 12pt)
export const SINGLE_LINE_SPACING = 240;

/** Resolve a frontmatter line-spacing value to OOXML twips (240 = single). */
export function resolveLineSpacingTwips(ls: string | number | undefined): number {
  if (ls === 'single') return 240;
  if (ls === '1.5') return 360;
  if (ls === 'double') return 480;
  if (typeof ls === 'number') return Math.round(ls * 240);
  return 276; // default 1.15
}
// Left/right indent for shading-mode code blocks to prevent margin overflow (~0.22in)
export const CODE_BLOCK_MARGIN_INDENT = 317;

export interface FontOverrides {
  bodyFont?: string;
  codeFont?: string;
  bodySizeHp?: number;
  codeSizeHp?: number;
  headingSizesHp?: Map<string, number>;
  headingFonts?: Map<string, string>;
  headingStyles?: Map<string, string>;
  titleFonts?: string[];
  titleSizesHp?: number[];
  titleStyles?: string[];
  tableFont?: string;
  tableSizeHp?: number;
  tableSizeFromDefault?: boolean; // true when tableSizeHp was auto-computed from DEFAULT_BODY_HP
  tableColWidths?: number[] | 'equal' | 'auto';
  tableBorders?: 'horizontal' | 'solid' | 'none';
}

/** The theme's minor font, which export's default font for the document,
 *  in docDefaults, is (see stylesXml and defaultThemeXml), and so the
 *  font of text with none of its own or of its styles: Word's, Calibri */
export const THEME_MINOR_FONT = 'Calibri';

/** The font export gives the table paragraph style, which a table's text
 *  without one of its own takes: the frontmatter's for tables, else its
 *  body font, or none, where the style takes the theme's */
export function tableStyleFont(overrides: FontOverrides): string | undefined {
  return overrides.tableFont ?? overrides.bodyFont;
}

/** The font export shows a table's text in where it has none of its own:
 *  the table paragraph style's, else the theme's minor font, which import
 *  writes no table's font for where Word shows its text in it from that
 *  style (see tableFontName in converter.ts) */
export function tableTextDefaultFont(overrides: FontOverrides): string {
  return tableStyleFont(overrides) ?? THEME_MINOR_FONT;
}

/** The fonts of a w:rFonts export sets a table's font as, the
 *  frontmatter's or a table's own: its font for ASCII and its font for the
 *  rest, not its East Asian or complex script one, so a table's East Asian
 *  text keeps the document's East Asian font. Import writes a table's font
 *  only where Word would show each character of its text in one of these
 *  (see runTextFont in converter.ts). */
export const TABLE_FONT_SLOTS = ['ascii', 'hAnsi'] as const;

/** A w:rFonts setting `font` as a table's (see TABLE_FONT_SLOTS) */
export function tableRFonts(font: string): string {
  return '<w:rFonts' + TABLE_FONT_SLOTS.map(slot => ' w:' + slot + '="' + escapeXmlAttribute(font) + '"').join('') + '/>';
}

/** Whether export writes a table's font, `font`, its directive's or else
 *  the frontmatter's for tables, on a run of the table's text, `run`, or
 *  on its paragraphs' marks, where none is given: where that's not the
 *  frontmatter's, which it leaves to the table paragraph style (see
 *  generateTable), and not on inline code. A run in a character style with
 *  a font of its own, as inline code is, CodeChar, shows that font over
 *  the table paragraph style's, but not over one on the run, so inline
 *  code shows in the code font in a table, as it does outside one. */
export function tableFontOnRuns(overrides: FontOverrides | undefined, font: string | undefined, run?: MdRun): boolean {
  return !!font && font !== overrides?.tableFont && !run?.code;
}

/** The font export shows inline code and code blocks in: the
 *  frontmatter's, or else Consolas */
export function codeFontName(overrides: FontOverrides | undefined): string {
  return overrides?.codeFont || 'Consolas';
}

/** Resolve value at index with Array_Inheritance: use arr[i] if i < length, else arr[last]. */
export function resolveAtIndex<T>(arr: T[] | undefined, index: number): T | undefined {
  if (!arr || arr.length === 0) return undefined;
  return index < arr.length ? arr[index] : arr[arr.length - 1];
}

export interface CodeBlockConfig {
  background?: string;
  insetMode: boolean;
  codeFontColor?: string;
  codeBlockInset?: number;
}

export function resolveFontOverrides(fm: Frontmatter): FontOverrides {
  const overrides: FontOverrides = {};

  if (fm.font) {
    overrides.bodyFont = fm.font;
  }
  if (fm.codeFont) {
    overrides.codeFont = fm.codeFont;
  }

  if (fm.fontSize !== undefined) {
    const bodySizeHp = Math.round(fm.fontSize * 2);
    overrides.bodySizeHp = bodySizeHp;

    // Proportional heading scaling: preserve ratio relative to default 11pt body
    const headingSizesHp = new Map<string, number>();
    for (const [styleId, defaultHp] of Object.entries(DEFAULT_HEADING_SIZES_HP)) {
      headingSizesHp.set(styleId, Math.round(defaultHp / DEFAULT_BODY_HP * bodySizeHp));
    }
    overrides.headingSizesHp = headingSizesHp;

    // Code-font-size inference: body - 2hp (1pt), clamped to minimum 1hp
    if (fm.codeFontSize === undefined) {
      overrides.codeSizeHp = Math.max(1, bodySizeHp - 2);
    }
  }

  if (fm.codeFontSize !== undefined) {
    overrides.codeSizeHp = Math.round(fm.codeFontSize * 2);
  }

  // Per-heading font overrides
  const HEADING_IDS = ['Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6'];
  if (fm.headerFont || fm.font) {
    const headingFonts = new Map<string, string>();
    for (let i = 0; i < 6; i++) {
      const font = resolveAtIndex(fm.headerFont, i) ?? fm.font;
      if (font) headingFonts.set(HEADING_IDS[i], font);
    }
    if (headingFonts.size > 0) overrides.headingFonts = headingFonts;
  }

  // Per-heading style overrides
  if (fm.headerFontStyle) {
    const headingStyles = new Map<string, string>();
    for (let i = 0; i < 6; i++) {
      const style = resolveAtIndex(fm.headerFontStyle, i);
      if (style) headingStyles.set(HEADING_IDS[i], style);
    }
    if (headingStyles.size > 0) overrides.headingStyles = headingStyles;
  }

  // Per-heading explicit size overrides (take precedence over proportional scaling)
  if (fm.headerFontSize) {
    if (!overrides.headingSizesHp) overrides.headingSizesHp = new Map<string, number>();
    for (let i = 0; i < 6; i++) {
      const size = resolveAtIndex(fm.headerFontSize, i);
      if (size !== undefined) overrides.headingSizesHp.set(HEADING_IDS[i], Math.round(size * 2));
    }
  }

  // Title font overrides
  if (fm.titleFont || fm.font) {
    const arr = fm.titleFont ?? (fm.font ? [fm.font] : undefined);
    if (arr) overrides.titleFonts = arr;
  }
  if (fm.titleFontSize) {
    overrides.titleSizesHp = fm.titleFontSize.map(s => Math.round(s * 2));
  }
  if (fm.titleFontStyle) {
    overrides.titleStyles = fm.titleFontStyle;
  }

  // Table column width overrides
  if (fm.tableColWidths) {
    overrides.tableColWidths = fm.tableColWidths;
  }

  // Table border style
  if (fm.tableBorders) {
    overrides.tableBorders = fm.tableBorders;
  }

  // Table font overrides
  if (fm.tableFont) {
    overrides.tableFont = fm.tableFont;
  }
  if (fm.tableFontSize !== undefined) {
    overrides.tableSizeHp = Math.round(fm.tableFontSize * 2);
  } else if (fm.fontSize !== undefined) {
    // Auto-shrink: tables use body - 2pt (4hp)
    overrides.tableSizeHp = Math.max(1, Math.round(fm.fontSize * 2) - 4);
  } else {
    // Auto-shrink from default body size; may be recomputed from template Normal
    overrides.tableSizeHp = Math.max(1, DEFAULT_BODY_HP - 4);
    overrides.tableSizeFromDefault = true;
  }

  return overrides;
}

// --- Template font override application ---
// Style IDs that receive body font/size overrides
const BODY_STYLE_IDS = new Set([
  'Normal', 'Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6',
  'Title', 'Quote', 'IntenseQuote', 'GitHub', 'GitHubBlockquote', 'GitHubNote', 'GitHubTip', 'GitHubImportant', 'GitHubWarning', 'GitHubCaution', 'FootnoteText', 'EndnoteText',
]);
// Style IDs that receive code font/size overrides
const CODE_STYLE_IDS = new Set(['CodeChar', 'CodeBlock']);
// Style IDs that receive table font/size overrides
const TABLE_STYLE_IDS = new Set(['TableParagraph']);

/** A property of a heading or title font style: the element that turns it
 *  on, the one that turns it off, and whether a font style such as
 *  bold-center wants it. */
interface FontStyleProperty { tag: string; on: string; off: string; wanted: (fontStyle: string) => boolean }

/** The run properties a heading or title font style sets, in the order export
 *  writes them. smallcaps holds allcaps's letters, so allcaps is caps only
 *  without it. */
const FONT_STYLE_RUN_PROPERTIES: FontStyleProperty[] = [
  { tag: 'w:b', on: '<w:b/>', off: '<w:b w:val="0"/>', wanted: style => style.includes('bold') },
  { tag: 'w:i', on: '<w:i/>', off: '<w:i w:val="0"/>', wanted: style => style.includes('italic') },
  { tag: 'w:u', on: '<w:u w:val="single"/>', off: '<w:u w:val="none"/>', wanted: style => style.includes('underline') },
  { tag: 'w:smallCaps', on: '<w:smallCaps/>', off: '<w:smallCaps w:val="0"/>', wanted: style => style.includes('smallcaps') },
  { tag: 'w:caps', on: '<w:caps/>', off: '<w:caps w:val="0"/>', wanted: style => style.includes('allcaps') && !style.includes('smallcaps') },
];

/** Centering, the paragraph property of a heading or title font style */
const FONT_STYLE_CENTERING: FontStyleProperty = { tag: 'w:jc', on: '<w:jc w:val="center"/>', off: '<w:jc w:val="left"/>', wanted: style => style.includes('center') };

/** Whether a font style property's element turns it on: w:jc when it centers,
 *  w:u unless it's none, and the others unless w:val turns them off, as
 *  import reads them (see extractStyle in converter.ts). */
function fontStylePropertyOn(property: FontStyleProperty, element: string): boolean {
  const val = xmlAttribute(element, 'w:val');
  if (property === FONT_STYLE_CENTERING) return val === 'center';
  if (property.tag === 'w:u') return val !== 'none';
  return val === undefined || val === 'true' || val === '1' || val === 'on';
}

/** A style's content with a pPr added where the schema orders a style's
 *  children: after its name, base and the like, and before its rPr and table
 *  properties, found in its markup, not a comment (see xmlSearch). */
function withStylePPr(inner: string, pPr: string): string {
  const end = xmlSearch(inner, /<w:(?:rPr|tblPr|trPr|tcPr|tblStylePr)\b/) ?? inner.length;
  return inner.slice(0, end) + pPr + inner.slice(end);
}

/**
 * Apply font overrides to a template's word/styles.xml content.
 * Decodes the raw bytes, finds <w:style> elements by w:styleId,
 * and inserts/replaces w:rFonts and w:sz/w:szCs in each matching
 * style's <w:rPr> section. Styles not present in the template are
 * silently skipped.
 */
/** The built-in styles export refers to by their English IDs, by their names
 *  in styles.xml, lowercased, which Word keeps in English whatever the
 *  language it gives a style's ID in, and their types: the reference marks'
 *  are character styles (see templateStyleIds) */
const BUILT_IN_STYLES = new Map<string, { name: string; type: string }>([
  ...[
    ['Normal', 'normal'],
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(level => ['Heading' + level, 'heading ' + level]),
    ['Title', 'title'], ['Quote', 'quote'], ['IntenseQuote', 'intense quote'],
    ['FootnoteText', 'footnote text'], ['EndnoteText', 'endnote text'], ['Bibliography', 'bibliography'],
    ['Caption', 'caption'],
  ].map(([id, name]) => [id, { name, type: 'paragraph' }] as [string, { name: string; type: string }]),
  ...[
    ['FootnoteReference', 'footnote reference'], ['EndnoteReference', 'endnote reference'],
    ['CommentReference', 'annotation reference'],
  ].map(([id, name]) => [id, { name, type: 'character' }] as [string, { name: string; type: string }]),
]);

/**
 * A template's own ID for each built-in style export refers to by its
 * English ID, where the template gives the style another: Word in another
 * language gives a built-in style an ID from the name it shows, as
 * `berschrift1` for German's Überschrift 1, and `Standard` for Normal, but
 * keeps its English name, `heading 1`, in w:name. Export refers to the
 * template's style by the template's ID, so Word shows a heading as one.
 * Where the template has a style of the English ID, or of one that differs
 * only in case, as Word matches style IDs, that one is the style, as import
 * reads it (see parseStyleLayouts in converter.ts). A template whose styles
 * have the English IDs gives none. Only a style of the built-in style's
 * type is it, as Word reads a w:pStyle only of a paragraph style and a
 * w:rStyle only of a character style.
 */
export function templateStyleIds(stylesXml: string | undefined): Map<string, string> {
  const ids = new Map<string, string>();
  if (!stylesXml) return ids;
  // The template's styles, by their types and IDs, and by their types and
  // names, lowercased, each read as an XML parser reads it (see
  // xmlElement), so one written as <w:style .../> ends there, its IDs with
  // their character references read, as import reads them
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (let style = xmlElement(stylesXml, 'w:style'); style; style = xmlElement(stylesXml, 'w:style', style.end)) {
    const id = xmlAttribute(style.tag, 'w:styleId');
    if (!id) continue;
    // A style without a type is a paragraph style
    const type = xmlAttribute(style.tag, 'w:type') ?? 'paragraph';
    if (!byId.has(type + ' ' + id.toLowerCase())) byId.set(type + ' ' + id.toLowerCase(), id);
    const nameTag = xmlStartTag(style.content, 'w:name');
    const name = nameTag && xmlAttribute(nameTag.tag, 'w:val')?.toLowerCase();
    if (name !== undefined && !byName.has(type + ' ' + name)) byName.set(type + ' ' + name, id);
  }
  for (const [builtInId, { name, type }] of BUILT_IN_STYLES) {
    const id = byId.get(type + ' ' + builtInId.toLowerCase()) ?? byName.get(type + ' ' + name);
    if (id !== undefined && id !== builtInId) ids.set(builtInId, id);
  }
  return ids;
}

/** The type of style each element that refers to a style by its ID refers
 *  to, by the type of the style it's in, where it's in one: a style's base
 *  and next style are of its type, and the style it's linked to of the
 *  other, a paragraph style's a character style and a character style's a
 *  paragraph style. An abstract numbering's w:numStyleLink and w:styleLink,
 *  in numbering.xml, refer to a numbering style. */
const STYLE_REFERENCE_TYPES: Record<string, (owner: string | undefined) => string | undefined> = {
  'w:pStyle': () => 'paragraph',
  'w:rStyle': () => 'character',
  'w:tblStyle': () => 'table',
  'w:numStyleLink': () => 'numbering',
  'w:styleLink': () => 'numbering',
  'w:basedOn': owner => owner,
  'w:next': owner => owner,
  'w:link': owner => owner === 'paragraph' ? 'character' : owner === 'character' ? 'paragraph' : undefined,
};
const STYLE_REFERENCE_ELEMENTS = Object.keys(STYLE_REFERENCE_TYPES);

/** `xml` with each reference to a built-in style by its English ID by the
 *  template's ID for the style instead (see templateStyleIds), where it
 *  refers to a style of the built-in style's type: a paragraph's, run's or
 *  table's style, and a style's base, next style and link. One to another
 *  style of the English ID, as a character style `Normal` beside the
 *  paragraph style `Standard` named Normal, stays. */
export function withTemplateStyleIds(xml: string, ids: Map<string, string>): string {
  if (ids.size === 0) return xml;
  return withStyleReferences(xml, (id, type) => BUILT_IN_STYLES.get(id)?.type === type ? ids.get(id) : undefined);
}

/** `xml` with each reference to a style, a paragraph's, run's or table's
 *  style or a style's base, next style or link, to the ID `idFor` gives for
 *  the ID it refers to and the type of style it refers to (see
 *  STYLE_REFERENCE_TYPES), where it gives one, and as it was where it gives
 *  none */
export function withStyleReferences(xml: string, idFor: (id: string, type: string) => string | undefined): string {
  // Each reference in `part`, in a style of the type `owner` or in none,
  // its tag read as an XML parser reads it (see xmlStartTag)
  const references = (part: string, owner: string | undefined) => {
    let out = '';
    let at = 0;
    for (const { name, tag, start, end } of xmlStartTags(part, STYLE_REFERENCE_ELEMENTS)) {
      const id = xmlAttribute(tag, 'w:val');
      const type = STYLE_REFERENCE_TYPES[name](owner);
      const to = id === undefined || type === undefined ? undefined : idFor(id, type);
      if (to === undefined || to === id) continue;
      out += part.slice(at, start) + withXmlAttribute(tag, 'w:val', to);
      at = end;
    }
    return out + part.slice(at);
  };
  // Those in a style by its type, a style without one a paragraph style's,
  // and the others by none, each style read as an XML parser reads it (see
  // xmlElement), so one written as <w:style .../> holds none
  let out = '';
  let at = 0;
  for (let style = xmlElement(xml, 'w:style'); style; style = xmlElement(xml, 'w:style', style.end)) {
    const contentEnd = style.start + style.tag.length + style.content.length;
    out += references(xml.slice(at, style.start), undefined) + style.tag
      + references(style.content, xmlAttribute(style.tag, 'w:type') ?? 'paragraph') + xml.slice(contentEnd, style.end);
    at = style.end;
  }
  return out + references(xml.slice(at), undefined);
}

/** The w:style element of the style `id` in `stylesXml`, found as import
 *  finds it (see findStyleElement), by the template's ID for a built-in
 *  style (see templateStyleIds), as its start tag, content and end tag, and
 *  where it starts and ends, where it has a body: one written as
 *  <w:style .../> has none. With `anyType`, as for a character style, the
 *  style of the ID itself is of any type. */
function templateStyleParts(stylesXml: string, id: string, ids: Map<string, string>, anyType = false): { open: string; content: string; close: string; start: number; end: number } | undefined {
  const found = findStyleElement(stylesXml, id, ids, anyType);
  const style = found && xmlElement(found.element, 'w:style');
  if (!found || !style || style.tag.length === found.element.length) return undefined;
  const contentEnd = style.tag.length + style.content.length;
  return { open: style.tag, content: style.content, close: found.element.slice(contentEnd), start: found.at, end: found.at + found.element.length };
}

/** Styles XML with `style` added last, before the end tag of w:styles, in
 *  its markup, not a comment (see xmlSearch) */
function withStyleAdded(xml: string, style: string): string {
  const end = xmlSearch(xml, /<\/w:styles\s*>/);
  return end !== undefined ? xml.slice(0, end) + style + xml.slice(end) : xml;
}

/**
 * Styles XML with each tracked change's record of what a style's or the
 * document defaults' formatting was (w:rPrChange, w:pPrChange), which Word
 * doesn't show, set aside as an empty element of its name and number, and
 * `restore`, which puts the records back in XML changed since. What reads
 * or changes a style as it is now, as Word shows it, then leaves the
 * records as they were.
 */
function setRecordsAside(xml: string): { xml: string; restore: (changed: string) => string } {
  const records: string[] = [];
  // Each read as an XML parser reads it (see replaceXmlElements)
  const aside = replaceXmlElements(xml, ['w:rPrChange', 'w:pPrChange'], (record, name) =>
    '<' + name + ' record="' + (records.push(record) - 1) + '"/>');
  return { xml: aside, restore: changed => changed.replace(/<w:(?:rPrChange|pPrChange) record="(\d+)"\/>/g, (_match, index: string) => records[Number(index)]) };
}

/** A pPr's or rPr's own properties, and a record set aside in it (see
 *  setRecordsAside), which the schema puts after them, wherever what's
 *  added went */
function splitRecord(content: string, tag: 'pPrChange' | 'rPrChange'): [string, string] {
  const record = new RegExp('<w:' + tag + ' record="\\d+"/>').exec(content)?.[0];
  return record === undefined ? [content, ''] : [content.replace(record, ''), record];
}

/** Extract the Normal style's font size (in half-points) from styles XML. */
export function extractNormalStyleSizeHp(stylesXml: string, ids = templateStyleIds(stylesXml)): number | undefined {
  const normal = templateStyleParts(stylesXml, 'Normal', ids);
  // Its first w:sz, read as an XML parser reads it, and its value as
  // import reads it (see xmlHalfPoints)
  const size = normal && xmlStartTag(setRecordsAside(normal.content).xml, 'w:sz');
  return xmlHalfPoints(size && xmlAttribute(size.tag, 'w:val'));
}

/**
 * `stylesXml` without the w:sz or w:szCs of each of `styleIds` that its base
 * gives it already, which Word strips (dirty-flag invariant #5), as for a
 * Heading 4 at Normal's size. A style's base is the nearest along its
 * w:basedOn that sets the size, or else the document defaults, or else
 * Word's 10pt, without a tracked change's record of what one was
 * (w:rPrChange), which Word doesn't show. Each style is found as import
 * finds it (see findStyleElement), by `ids`, the template's IDs for the
 * built-in styles (see templateStyleIds). A style based on none, or on one
 * whose w:basedOn comes back around, is left as it is, and so is one whose
 * w:basedOn reaches a style Word ignores, its properties and base and all,
 * as a paragraph style NoList (see wordIgnoresStyle). Leaving a size out
 * changes no style's size, so the order of `styleIds` doesn't matter.
 */
export function withoutInheritedSizes(stylesXml: string, styleIds: string[], ids: Map<string, string>): string {
  // Each element read as an XML parser reads it (see xmlElement), as import
  // reads them, and as Word shows it, without a tracked change's record of
  // what it was (see setRecordsAside): a style's own rPr, not one in its
  // pPr, its base, and its sizes, in whole half-points, as import reads
  // them (see xmlHalfPoints)
  const ownRPr = (block: string) => xmlElement(block, 'w:rPr', xmlElement(block, 'w:pPr')?.end ?? 0);
  const basedOn = (block: string) => { const base = xmlStartTag(block, 'w:basedOn'); return base && xmlAttribute(base.tag, 'w:val'); };
  const sizeIn = (rPr: string, tag: string) => {
    const size = xmlStartTag(rPr, tag);
    return xmlHalfPoints(size && xmlAttribute(size.tag, 'w:val'));
  };
  const live = (part: string) => setRecordsAside(part).xml;
  const docDefaults = live(xmlElement(stylesXml, 'w:docDefaults')?.content ?? '');
  const defaults = xmlElement(xmlElement(docDefaults, 'w:rPrDefault')?.content ?? '', 'w:rPr')?.content ?? '';
  let xml = stylesXml;
  // The styles of `xml`, read once for each time it changes (see
  // styleFinder), so that a long chain, among many styles, takes time in
  // proportion to them
  let find = styleFinder(xml);
  // The styles along a style's w:basedOn in `xml`, nearest first, or
  // undefined where they come back around, each known by where it is, or
  // reach one Word ignores
  const bases = (style: { at: number; element: string }) => {
    const chain: string[] = [];
    const seen = new Set([style.at]);
    for (let id = basedOn(style.element); id !== undefined;) {
      const base = find(id, ids);
      if (base === undefined) break;
      if (seen.has(base.at) || wordIgnoresStyle(base.element)) return undefined;
      seen.add(base.at);
      chain.push(live(base.element));
      id = basedOn(base.element);
    }
    return chain;
  };
  const inherited = (chain: string[], tag: string) => {
    for (const base of chain) {
      const size = sizeIn(ownRPr(base)?.content ?? '', tag);
      if (size !== undefined) return size;
    }
    return sizeIn(defaults, tag) ?? 20;
  };
  for (const styleId of styleIds) {
    const style = find(styleId, ids);
    if (style === undefined || basedOn(style.element) === undefined) continue;
    const chain = bases(style);
    if (chain === undefined) continue;
    const records = setRecordsAside(style.element);
    const block = records.xml;
    const rPr = ownRPr(block);
    if (rPr === undefined) continue;
    let content = rPr.content;
    for (const tag of ['w:sz', 'w:szCs']) {
      const size = xmlElement(content, tag);
      if (size !== undefined && sizeIn(content, tag) === inherited(chain, tag)) content = content.slice(0, size.start) + content.slice(size.end);
    }
    if (content === rPr.content) continue;
    // An rPr left with no element goes too, with a comment or what else is
    // in it (see holdsXmlElement), and one with what's left keeps its tags
    const written = !holdsXmlElement(content) ? '' : rPr.tag + content + block.slice(rPr.start + rPr.tag.length + rPr.content.length, rPr.end);
    xml = xml.slice(0, style.at) + records.restore(block.slice(0, rPr.start) + written + block.slice(rPr.end)) + xml.slice(style.at + style.element.length);
    find = styleFinder(xml);
  }
  return xml;
}

/**
 * A style's w:rFonts with `font` for Latin text, its w:ascii and w:hAnsi,
 * which a frontmatter font sets, in place of a theme font there
 * (w:asciiTheme, w:hAnsiTheme), which Word would show over it (ECMA-376
 * Part 1 §17.3.2.26). What it names for other scripts, as w:eastAsia or
 * w:cstheme, and its w:hint, stay as they were.
 */
function rFontsWithFont(rFonts: string, font: string): string {
  const others = otherXmlAttributes(rFonts, ['w:ascii', 'w:hAnsi', 'w:asciiTheme', 'w:hAnsiTheme']);
  return '<w:rFonts w:ascii="' + escapeXmlAttribute(font) + '" w:hAnsi="' + escapeXmlAttribute(font) + '"' + others + '/>';
}

/**
 * A template's styles with the font overrides applied (see
 * templateWithFontOverrides), and each size a heading or the title is
 * given left out where its base gives the same (see withoutInheritedSizes),
 * for styles written as they are. Export, which adds styles after, as a
 * Bibliography a heading may be based on, leaves those sizes out of the
 * styles it writes, with all it adds.
 */
export function applyFontOverridesToTemplate(
  stylesXmlBytes: Uint8Array,
  overrides: FontOverrides,
  customStyles?: Record<string, import('./frontmatter').CustomStyleDef>
): string {
  const { xml, sizedStyleIds, ids } = templateWithFontOverrides(stylesXmlBytes, overrides, customStyles);
  return withoutInheritedSizes(xml, sizedStyleIds, ids);
}

/**
 * A template's styles with the font overrides applied, the headings and
 * title given a size, whose size goes where their base gives it, and the
 * template's IDs for the built-in styles (see templateStyleIds).
 */
export function templateWithFontOverrides(
  stylesXmlBytes: Uint8Array,
  overrides: FontOverrides,
  customStyles?: Record<string, import('./frontmatter').CustomStyleDef>
): { xml: string; sizedStyleIds: string[]; ids: Map<string, string> } {
  // In the encoding they declare, as UTF-16, and as export writes them
  let xml = asUtf8(decodeXml(stylesXmlBytes));
  // The template's IDs for the built-in styles, which its styles are found by
  const ids = templateStyleIds(xml);

  // Recompute auto-shrink from template's Normal style size when no explicit font-size
  if (overrides.tableSizeFromDefault) {
    const templateBodyHp = extractNormalStyleSizeHp(xml, ids);
    if (templateBodyHp !== undefined) {
      overrides.tableSizeHp = Math.max(1, templateBodyHp - 4);
    }
  }

  // Inject TableParagraph style if table overrides exist but the template lacks it
  if (overrides.tableSizeHp || overrides.tableFont) {
    if (!findStyleElement(xml, 'TableParagraph', ids, true)) {
      // Insert before </w:styles>
      const tableFont = tableStyleFont(overrides);
      const tableRpr = '<w:rPr>' +
        (tableFont ? tableRFonts(tableFont) : '') +
        (overrides.tableSizeHp
          ? '<w:sz w:val="' + overrides.tableSizeHp + '"/><w:szCs w:val="' + overrides.tableSizeHp + '"/>'
          : '') +
        '</w:rPr>';
      const tableStyle = '<w:style w:type="paragraph" w:styleId="TableParagraph">' +
        '<w:name w:val="Table Paragraph"/>' +
        '<w:basedOn w:val="Normal"/>' +
        tableRpr +
        '</w:style>';
      xml = withStyleAdded(xml, tableStyle);
    }
  }

  // Collect all style IDs we want to modify
  const allTargetIds = new Set([...BODY_STYLE_IDS, ...CODE_STYLE_IDS, ...TABLE_STYLE_IDS]);
  // The headings and title given a size, which goes where their base gives it
  const sizedStyleIds: string[] = [];

  // The template's styles as they come, for what a style inherits, each
  // found as import finds it (see findStyleElement), by the template's ID for
  // a built-in style; with its ID, or a built-in style's English ID, which
  // a heading's font style goes by; and without a tracked change's record of
  // what it was, which Word doesn't show (w:rPrChange, w:pPrChange)
  const withoutFormatChanges = (part: string) => replaceXmlElements(part, ['w:rPrChange', 'w:pPrChange'], () => '');
  const findTemplateStyle = styleFinder(xml);
  const builtInIds = new Map([...ids].map(([builtInId, id]) => [id, builtInId]));
  const templateStyles = new Map<string, { id: string; block: string } | undefined>();
  const templateStyle = (id: string) => {
    if (!templateStyles.has(id)) {
      const found = findTemplateStyle(id, ids);
      const ownId = found ? xmlAttribute(xmlStartTag(found.element, 'w:style')?.tag ?? '', 'w:styleId') ?? id : id;
      templateStyles.set(id, found && { id: builtInIds.get(ownId) ?? ownId, block: withoutFormatChanges(found.element) });
    }
    return templateStyles.get(id);
  };
  // The document defaults' run and paragraph properties, the base of every
  // style, without one too, each element read as an XML parser reads it
  // (see xmlElement)
  const docDefaults = withoutFormatChanges(xmlElement(xml, 'w:docDefaults')?.content ?? '');
  const defaultProperties = (property: FontStyleProperty) => {
    const [defaults, properties] = property === FONT_STYLE_CENTERING ? ['w:pPrDefault', 'w:pPr'] : ['w:rPrDefault', 'w:rPr'];
    return xmlElement(xmlElement(docDefaults, defaults)?.content ?? '', properties)?.content ?? '';
  };
  const fontStyleOf = (styleId: string) =>
    /^Heading[1-6]$/.test(styleId) ? overrides.headingStyles?.get(styleId) : styleId === 'Title' ? overrides.titleStyles?.[0] : undefined;
  // Its attributes as XML may spell them, as import reads them
  const basedOn = (id: string) => {
    const base = xmlStartTag(templateStyle(id)?.block ?? '', 'w:basedOn');
    return base && xmlAttribute(base.tag, 'w:val');
  };
  /**
   * Whether a style, or else the styles it's based on (w:basedOn) or the
   * document defaults, turn a font style property on, which Word shows where
   * a style doesn't set it. The nearest that sets it decides, as import reads
   * it (see inheritedStyle in converter.ts), and a heading or title restyled
   * here sets it as its font style says.
   */
  const turnsOn = (first: string | undefined, property: FontStyleProperty, seen = new Set<string>()): boolean => {
    for (let id = first; id !== undefined; id = basedOn(id)) {
      const style = templateStyle(id);
      if (style === undefined || seen.has(style.id)) break;
      seen.add(style.id);
      const { block } = style;
      const fontStyle = fontStyleOf(style.id);
      if (fontStyle !== undefined) return property.wanted(fontStyle);
      // Its pPr, or its own rPr, not one in its pPr
      const pPr = xmlElement(block, 'w:pPr');
      const properties = property === FONT_STYLE_CENTERING ? pPr : xmlElement(block, 'w:rPr', pPr?.end ?? 0);
      const found = xmlStartTag(properties?.content ?? '', property.tag);
      if (found) return fontStylePropertyOn(property, found.tag);
    }
    const found = xmlStartTag(defaultProperties(property), property.tag);
    return found !== undefined && fontStylePropertyOn(property, found.tag);
  };
  /** Whether what a style is based on turns a font style property on */
  const inheritsOn = (styleId: string, property: FontStyleProperty) => turnsOn(basedOn(styleId), property, new Set([styleId]));
  /** A font style's run properties: each it wants, and for one it leaves
   *  out, the style's own off (`ownOff`), or else an explicit off where the
   *  style's base turns it on, which removing the style's own leaves. */
  const fontStyleRunElements = (styleId: string, fontStyle: string, ownOff = new Map<FontStyleProperty, string>()) => orderRPr(FONT_STYLE_RUN_PROPERTIES
    .map(property => property.wanted(fontStyle) ? property.on
      : ownOff.get(property) ?? (inheritsOn(styleId, property) ? property.off : '')).join(''));

  for (const styleId of allTargetIds) {
    // Find the <w:style ...w:styleId="ID"...> ... </w:style> block, as
    // import finds it, by the template's ID for a built-in style, and code's
    // character style, CodeChar, too
    const style = templateStyleParts(xml, styleId, ids, styleId === 'CodeChar');
    if (!style) continue; // style not in template — skip silently

    const openTag = style.open;
    // What the style is now changes, and the records of its tracked changes
    // go as they were
    const records = setRecordsAside(style.content);
    let innerContent = records.xml;
    const closeTag = style.close;

    const isCodeStyle = CODE_STYLE_IDS.has(styleId);
    const isTableStyle = TABLE_STYLE_IDS.has(styleId);
    const isHeading = /^Heading[1-6]$/.test(styleId);
    const isTitle = styleId === 'Title';

    // Determine font: heading-specific > title-specific > table > body/code font
    let font: string | undefined;
    if (isCodeStyle) {
      font = overrides.codeFont;
    } else if (isTableStyle) {
      font = tableStyleFont(overrides);
    } else if (isHeading && overrides.headingFonts?.has(styleId)) {
      font = overrides.headingFonts.get(styleId);
    } else if (isTitle && overrides.titleFonts?.[0]) {
      font = overrides.titleFonts[0];
    } else {
      font = overrides.bodyFont;
    }

    // Determine the size for this style
    let sizeHp: number | undefined;
    if (isCodeStyle) {
      if (styleId === 'CodeBlock') sizeHp = overrides.codeSizeHp;
    } else if (isTableStyle) {
      sizeHp = overrides.tableSizeHp;
    } else if (isTitle && overrides.titleSizesHp?.[0]) {
      sizeHp = overrides.titleSizesHp[0];
    } else if (overrides.headingSizesHp && overrides.headingSizesHp.has(styleId)) {
      sizeHp = overrides.headingSizesHp.get(styleId);
    } else if (styleId === 'Normal') {
      sizeHp = overrides.bodySizeHp;
    }

    // Determine style override for headings and title
    let fontStyleOverride: string | undefined;
    if (isHeading) fontStyleOverride = overrides.headingStyles?.get(styleId);
    else if (isTitle) fontStyleOverride = overrides.titleStyles?.[0];

    // Nothing to do for this style
    if (font === undefined && sizeHp === undefined && fontStyleOverride === undefined) continue;
    // An empty pPr or rPr, self-closing, goes, for what's written here to go
    // in a container of its own, once, or nowhere (dirty-flag invariant #5),
    // but not one a tracked change records, which is set aside (see
    // setRecordsAside)
    for (const name of ['w:pPr', 'w:rPr']) {
      innerContent = replaceXmlElements(innerContent, [name], element => xmlStartTag(element, name)?.empty ? '' : element);
    }
    if (sizeHp !== undefined && (isHeading || isTitle)) sizedStyleIds.push(styleId);

    // Build the replacement fragments
    const rFontsEl = font === undefined ? undefined
      : isTableStyle ? tableRFonts(font)
      : '<w:rFonts w:ascii="' + escapeXmlAttribute(font) + '" w:hAnsi="' + escapeXmlAttribute(font) + '"/>';
    const szEl = sizeHp !== undefined
      ? '<w:sz w:val="' + sizeHp + '"/>'
      : undefined;
    const szCsEl = sizeHp !== undefined
      ? '<w:szCs w:val="' + sizeHp + '"/>'
      : undefined;

    // Apply center alignment override to <w:pPr> for headings and title
    if (fontStyleOverride !== undefined) {
      // Centered, or left where the style's base centers it
      const jc = FONT_STYLE_CENTERING.wanted(fontStyleOverride) ? FONT_STYLE_CENTERING.on
        : inheritsOn(styleId, FONT_STYLE_CENTERING) ? FONT_STYLE_CENTERING.off : '';
      // Read as an XML parser reads it, as each element here (see xmlElement)
      const pPr = xmlElementParts(innerContent, 'w:pPr');
      if (pPr) {
        let pPrContent = pPr.content;
        // Remove any existing w:jc element, then insert it before what the
        // schema puts after it: spacing → ind → jc → textDirection →
        // textAlignment → outlineLvl and the rest.
        // A font style that isn't centered keeps the style's own w:jc that
        // doesn't center, which may undo the centering of its base, in place
        // of an explicit off
        pPrContent = replaceXmlElements(pPrContent, ['w:jc'], element =>
          !FONT_STYLE_CENTERING.wanted(fontStyleOverride) && !fontStylePropertyOn(FONT_STYLE_CENTERING, xmlStartTag(element, 'w:jc')!.tag) ? element : '');
        if (jc && !xmlStartTag(pPrContent, 'w:jc')) {
          const at = xmlSearch(pPrContent, /<w:(?:textDirection|textAlignment|textboxTightWrap|outlineLvl|divId|cnfStyle|rPr|sectPr|pPrChange)\b/) ?? pPrContent.length;
          // With the template's own in the order CT_PPrBase gives them, as
          // Word writes them (dirty-flag invariant #3)
          pPrContent = orderPPr(pPrContent.slice(0, at) + jc + pPrContent.slice(at));
        }
        // A pPr that held only the w:jc goes with it (dirty-flag invariant #5),
        // a comment or what else holds no element beside it too (see
        // holdsXmlElement), but not one that holds a tracked change's record,
        // which needs it, last, after a w:jc added at the end
        const [ownPPr, pPrRecord] = splitRecord(pPrContent, 'pPrChange');
        const newPPr = holdsXmlElement(ownPPr) || pPrRecord ? pPr.open + ownPPr + pPrRecord + pPr.close : '';
        innerContent = innerContent.slice(0, pPr.start) + newPPr + innerContent.slice(pPr.end);
      } else if (jc) {
        // No pPr block — insert one
        innerContent = withStylePPr(innerContent, '<w:pPr>' + jc + '</w:pPr>');
      }
    }

    // Skip past any <w:pPr>...</w:pPr> block so we match the style-level
    // <w:rPr>, not one nested inside paragraph properties.
    const rPr = xmlElementParts(innerContent, 'w:rPr', xmlElement(innerContent, 'w:pPr')?.end ?? 0);

    if (rPr) {
      // Modify existing <w:rPr> content
      const [ownRPr, rPrRecord] = splitRecord(rPr.content, 'rPrChange');
      let rPrContent = ownRPr;

      if (font !== undefined && rFontsEl !== undefined) {
        // Set the font in an existing w:rFonts, keeping what it names for
        // other scripts, or insert one at start of rPr content
        // Read as an XML parser reads it, whatever its values hold (see
        // xmlElement)
        const rFonts = xmlElement(rPrContent, 'w:rFonts');
        if (rFonts !== undefined) {
          rPrContent = rPrContent.slice(0, rFonts.start) + rFontsWithFont(rFonts.tag, font) + rPrContent.slice(rFonts.end);
        } else {
          rPrContent = rFontsEl + rPrContent;
        }
      }

      // Replace existing w:sz and w:szCs or append
      for (const [tag, element] of [['w:sz', szEl], ['w:szCs', szCsEl]] as const) {
        if (element === undefined) continue;
        const size = xmlElement(rPrContent, tag);
        rPrContent = size ? rPrContent.slice(0, size.start) + element + rPrContent.slice(size.end) : rPrContent + element;
      }

      // Apply font-style overrides (bold, italic, underline) for headings and title
      if (fontStyleOverride !== undefined) {
        // Remove existing b, i, u, smallCaps, caps elements (all toggle forms: self-closing, with attributes, open+close),
        // noting one that turns off what the font style leaves out, which
        // may undo what the style's base turns on, to write again in order.
        // Each goes with the whitespace before it, as orderRPr moves it, so
        // a style written on lines of its own comes back the same
        const ownOff = new Map<FontStyleProperty, string>();
        for (const property of FONT_STYLE_RUN_PROPERTIES) {
          let at = 0;
          for (let element = xmlElement(rPrContent, property.tag, at); element; element = xmlElement(rPrContent, property.tag, at)) {
            at = rPrContent.slice(0, element.start).trimEnd().length;
            if (!property.wanted(fontStyleOverride) && !fontStylePropertyOn(property, element.tag)) ownOff.set(property, rPrContent.slice(at, element.end));
            rPrContent = rPrContent.slice(0, at) + rPrContent.slice(element.end);
          }
        }
        rPrContent = fontStyleRunElements(styleId, fontStyleOverride, ownOff) + rPrContent;
      }
      // What's written here, the font style's offs among it, in schema order
      // with what the style has, as Word writes run properties and reorders
      // others on open, marking the document changed (see orderRPr)
      rPrContent = orderRPr(rPrContent);

      // An rPr that held only what the style override removed goes with it
      // (dirty-flag invariant #5), a comment or what else holds no element
      // beside it too (see holdsXmlElement), but not one that holds a tracked
      // change's record, which needs it
      const newRPr = holdsXmlElement(rPrContent) || rPrRecord ? rPr.open + rPrContent + rPrRecord + rPr.close : '';
      innerContent = innerContent.slice(0, rPr.start) + newRPr + innerContent.slice(rPr.end);
    } else {
      // No <w:rPr> section — insert one
      let rPrContent = fontStyleOverride !== undefined ? fontStyleRunElements(styleId, fontStyleOverride) : '';
      if (rFontsEl !== undefined) rPrContent += rFontsEl;
      if (szEl !== undefined) rPrContent += szEl;
      if (szCsEl !== undefined) rPrContent += szCsEl;
      if (rPrContent) innerContent = innerContent + '<w:rPr>' + orderRPr(rPrContent) + '</w:rPr>';
    }

    innerContent = records.restore(innerContent);
    xml = xml.slice(0, style.start) + openTag + innerContent + closeTag + xml.slice(style.end);
  }

  // Inject custom styles before </w:styles>
  if (customStyles) {
    // Derive bodyFontStr from template's Normal style for custom style
    // inheritance, its first w:rFonts read as an XML parser reads it
    const normal = templateStyleParts(xml, 'Normal', ids);
    const normalRFonts = normal && xmlStartTag(setRecordsAside(normal.content).xml, 'w:rFonts');
    const normalFont = normalRFonts && xmlAttribute(normalRFonts.tag, 'w:ascii');
    const bodyFontStr = normalFont ? '<w:rFonts w:ascii="' + escapeXmlAttribute(normalFont) + '" w:hAnsi="' + escapeXmlAttribute(normalFont) + '"/>' : '';
    const localSzPair = (hp: number) => '<w:sz w:val="' + hp + '"/><w:szCs w:val="' + hp + '"/>';
    const seenIds = new Set<string>();
    for (const [name, def] of Object.entries(customStyles)) {
      const sid = customStyleId(name);
      if (seenIds.has(sid)) continue;
      seenIds.add(sid);
      const newStyleXml = customStyleXml(name, def, bodyFontStr, localSzPair, property => turnsOn('Normal', property));
      // Replace existing custom style, of any type, as it's found, in its
      // place, before what follows it as it was, whitespace or a comment,
      // or inject new one. A copy of it under the ID Word gave it, as
      // `Custombox` (see OwnStyle), stays till withStylesOnce, which leaves
      // it out and points what refers to it to this one.
      const existing = findStyleElement(xml, sid, ids, true);
      if (existing) {
        xml = xml.slice(0, existing.at) + newStyleXml.replace(/\n$/, '') + xml.slice(existing.at + existing.element.length);
      } else {
        xml = withStyleAdded(xml, newStyleXml);
      }
    }
  }

  return { xml, sizedStyleIds, ids };
}

/** Map from alert style ID → GfmAlertType for template color patching. */
const ALERT_STYLE_ID_TO_TYPE: Record<string, GfmAlertType> = {
  'GitHubNote': 'note',
  'GitHubTip': 'tip',
  'GitHubImportant': 'important',
  'GitHubWarning': 'warning',
  'GitHubCaution': 'caution',
};

/**
 * Patch template styles.xml to update Normal style line spacing and indent-mode after.
 * Also injects or patches Bibliography style for bibliographyHangingIndent.
 */
export function applyLineSpacingToTemplate(stylesXml: string, lineSpacingFm: string | number | undefined, indentMode: boolean, bibliographyHangingIndent: boolean | undefined): string {
  // What the styles are now changes, and the records of their tracked
  // changes go as they were
  const records = setRecordsAside(stylesXml);
  let xml = records.xml;
  const lsTwips = resolveLineSpacingTwips(lineSpacingFm);
  const afterVal = indentMode ? '0' : '200';
  // The template's IDs for the built-in styles, which its styles are found by
  const ids = templateStyleIds(xml);

  // Patch Normal style's paragraph spacing, the w:spacing of its pPr, not
  // the character spacing of the same name in its rPr, each element read as
  // an XML parser reads it (see xmlElement)
  const normal = templateStyleParts(xml, 'Normal', ids);
  if (normal) {
    let inner = normal.content;
    const newSpacing = '<w:spacing w:after="' + afterVal + '" w:line="' + lsTwips + '" w:lineRule="auto"/>';
    const pPr = xmlElementParts(inner, 'w:pPr');
    if (pPr) {
      // In place of its spacing, or else where CT_PPrBase puts it among the
      // template's, as after a widowControl or pBdr (dirty-flag invariant #3)
      const spacing = xmlElement(pPr.content, 'w:spacing');
      const at = spacing?.start ?? xmlElement(pPr.content, 'w:pBdr')?.end ?? 0;
      const content = orderPPr(pPr.content.slice(0, at) + newSpacing + pPr.content.slice(spacing?.end ?? at));
      inner = inner.slice(0, pPr.start) + pPr.open + content + pPr.close + inner.slice(pPr.end);
    } else {
      inner = withStylePPr(inner, '<w:pPr>' + newSpacing + '</w:pPr>');
    }
    xml = xml.slice(0, normal.start) + normal.open + inner + normal.close + xml.slice(normal.end);
  }

  // Patch pPrDefault w:spacing to match
  const pPrDefault = xmlElement(xml, 'w:pPrDefault');
  const defaultPPr = pPrDefault && xmlElementParts(pPrDefault.content, 'w:pPr');
  if (pPrDefault && defaultPPr) {
    const newSpacing = '<w:spacing w:after="160" w:line="' + lsTwips + '" w:lineRule="auto"/>';
    // In place of its spacing, or else where CT_PPrBase puts it among the
    // template's (dirty-flag invariant #3)
    const spacing = xmlElement(defaultPPr.content, 'w:spacing');
    const pPrContent = orderPPr(spacing
      ? defaultPPr.content.slice(0, spacing.start) + newSpacing + defaultPPr.content.slice(spacing.end)
      : newSpacing + defaultPPr.content);
    const at = pPrDefault.start + pPrDefault.tag.length;
    xml = xml.slice(0, at + defaultPPr.start) + defaultPPr.open + pPrContent + defaultPPr.close + xml.slice(at + defaultPPr.end);
  }

  // Inject or patch Bibliography style, of any type, as it's found
  if (!findStyleElement(xml, 'Bibliography', ids, true)) {
    const bibStyle = '<w:style w:type="paragraph" w:styleId="Bibliography">' +
      '<w:name w:val="Bibliography"/>' +
      '<w:basedOn w:val="Normal"/>' +
      '<w:pPr><w:spacing w:after="200" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/>' +
      (bibliographyHangingIndent !== false ? '<w:ind w:left="720" w:hanging="720"/>' : '') +
      '</w:pPr>' +
      '</w:style>';
    xml = withStyleAdded(xml, bibStyle);
  } else {
    // Template already defines Bibliography — merge w:left/w:hanging into its w:ind
    const bib = templateStyleParts(xml, 'Bibliography', ids, true);
    if (bib) {
      let inner = bib.content;
      const wantHanging = bibliographyHangingIndent !== false;
      const pPr = xmlElementParts(inner, 'w:pPr');
      if (pPr) {
        let pPrContent = pPr.content;
        const existingInd = xmlElement(pPrContent, 'w:ind');
        if (existingInd) {
          // Merge: strip w:left/w:hanging, then re-add if wanted (preserves other attrs like w:right)
          const attrs = otherXmlAttributes(existingInd.tag, ['w:left', 'w:hanging']) + (wantHanging ? ' w:left="720" w:hanging="720"' : '');
          const merged = attrs ? '<w:ind' + attrs + '/>' : '';
          pPrContent = pPrContent.slice(0, existingInd.start) + merged + pPrContent.slice(existingInd.end);
        } else if (wantHanging) {
          // No existing w:ind — insert after w:spacing for dirty-flag ordering (pBdr → spacing → ind)
          const indEl = '<w:ind w:left="720" w:hanging="720"/>';
          const spacing = xmlElement(pPrContent, 'w:spacing');
          if (spacing) {
            pPrContent = pPrContent.slice(0, spacing.end) + indEl + pPrContent.slice(spacing.end);
          } else {
            const insertBefore = xmlSearch(pPrContent, /<w:jc\b|<w:outlineLvl\b|<w:pPrChange\b/);
            pPrContent = insertBefore !== undefined
              ? pPrContent.slice(0, insertBefore) + indEl + pPrContent.slice(insertBefore)
              : pPrContent + indEl;
          }
          // Where CT_PPrBase puts it among the template's, as before a
          // contextualSpacing (dirty-flag invariant #3)
          pPrContent = orderPPr(pPrContent);
        }
        // A pPr that held only the indent goes, as Word strips an empty one
        // (dirty-flag invariant #5), with a comment or what else holds no
        // element beside it (see holdsXmlElement)
        const newPPr = holdsXmlElement(pPrContent) ? pPr.open + pPrContent + pPr.close : '';
        inner = inner.slice(0, pPr.start) + newPPr + inner.slice(pPr.end);
      } else if (wantHanging) {
        // No pPr exists yet — add one
        inner = withStylePPr(inner, '<w:pPr><w:ind w:left="720" w:hanging="720"/></w:pPr>');
      }
      xml = xml.slice(0, bib.start) + bib.open + inner + bib.close + xml.slice(bib.end);
    }
  }

  return records.restore(xml);
}

const LIST_CONTINUATION_STYLE_XML =
  '<w:style w:type="paragraph" w:customStyle="1" w:styleId="ManuscriptListContinuation">\n'
  + '<w:name w:val="Manuscript List Continuation"/>\n'
  + '<w:basedOn w:val="Normal"/>\n'
  + '<w:semiHidden/><w:unhideWhenUsed/>\n'
  + '</w:style>\n';

// The character style of a run of raw HTML that holds a line's end, which
// export writes as Word's line break, as Word shows a line feed in its text
// as a space and saves it so. Import reads the break in such a run as the
// HTML's line end again (see readParagraphLineFeeds in converter.ts).
export const RAW_HTML_STYLE_ID = 'ManuscriptHtml';

const RAW_HTML_STYLE_XML =
  '<w:style w:type="character" w:customStyle="1" w:styleId="' + RAW_HTML_STYLE_ID + '">\n'
  + '<w:name w:val="Manuscript HTML"/>\n'
  + '<w:semiHidden/><w:unhideWhenUsed/>\n'
  + '</w:style>\n';

/** Whether a run is raw HTML that holds a line's end, which export writes
 *  as Word's line break in the raw HTML style */
export const holdsRawHtmlLineEnd = (run: MdRun): boolean => !!run.rawHtml && run.text.includes('\n');

/** A run's text as `tag` elements, with each line end of its raw HTML as
 *  Word's line break */
export function rawHtmlTextElements(run: MdRun, tag: 'w:t' | 'w:delText'): string {
  return run.text.split('\n').map(line => line ? textElements(line, tag) : '').join('<w:br/>');
}

/** The Caption style, as Word's own: small, italic and in the theme's
 *  second text color, with space after it, its lines single spaced */
const CAPTION_STYLE_XML = '<w:style w:type="paragraph" w:styleId="Caption">\n'
  + '<w:name w:val="caption"/>\n'
  + '<w:basedOn w:val="Normal"/>\n'
  + '<w:next w:val="Normal"/>\n'
  + '<w:uiPriority w:val="35"/>\n'
  + '<w:unhideWhenUsed/>\n'
  + '<w:qFormat/>\n'
  + '<w:pPr><w:spacing w:after="200" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/></w:pPr>\n'
  + '<w:rPr><w:i/><w:iCs/><w:color w:val="44546A" w:themeColor="text2"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>\n'
  + '</w:style>\n';

/** Styles XML with the Caption style, for a document with captions, where
 *  the styles lack it: a template's Caption, of any type, as it's found, by
 *  its ID or, in a template from Word in another language, by its name */
export function withCaptionStyle(xml: string, ids: Map<string, string>): string {
  // Without the size its base gives it too (dirty-flag invariant #5)
  return findStyleElement(xml, 'Caption', ids, true) ? xml : withoutInheritedSizes(withStyleAdded(xml, CAPTION_STYLE_XML), ['Caption'], ids);
}

/**
 * A style export adds to a template's, as it writes it: its type, ID and
 * name. Word keeps a style's name but, when it saves, gives a custom style
 * an ID of its own, from its name without its spaces and punctuation, so
 * `ManuscriptHtml`, named Manuscript HTML, comes back as `ManuscriptHTML`,
 * and `MsCustomBox`, named Custom: box, as `Custombox`. Where two styles'
 * IDs differ only in case, as `ManuscriptHTML` and `ManuscriptHtml`, Word
 * takes them for one and gives the second another ID, `ManuscriptHTMLa`,
 * then `ManuscriptHTMLb` and on, and, where it repairs a document, which it
 * reports as Styles in Show Repairs, gives each style whose name another
 * has a name of its own, `Manuscript HTML0`, `Manuscript HTML00`,
 * `Manuscript HTML1` and on, though Word saves two of one name otherwise. So a
 * template saved by Word holds export's style under another ID, and, where
 * export through it added its own again, more of them each time, which is
 * how a document comes to hold dozens. `numbered`, export's own XML for
 * the style, takes a style whose name is its name and digits, as Word names
 * one in a repair, for a copy too, but only where Word's ID for it is
 * export's and a suffix, as `ManuscriptHTML12`, or where it's formatted as
 * export writes the style, as a user's style named `Manuscript HTML2`
 * needn't be either; a custom style has none, as `Custom: box2` is another
 * custom style's (see isOwnStyleCopy).
 */
export interface OwnStyle { type: string; id: string; name: string; numbered?: string }

/** Export's own styles, which a template saved by Word holds under other
 *  IDs (see OwnStyle) */
export const MANUSCRIPT_STYLES: OwnStyle[] = [
  { type: 'paragraph', id: 'ManuscriptListContinuation', name: 'Manuscript List Continuation', numbered: LIST_CONTINUATION_STYLE_XML },
  { type: 'character', id: RAW_HTML_STYLE_ID, name: 'Manuscript HTML', numbered: RAW_HTML_STYLE_XML },
];

/** A custom style the frontmatter defines, as export writes it (see
 *  customStyleXml) */
export function customOwnStyle(name: string): OwnStyle {
  return { type: 'paragraph', id: customStyleId(name), name: customStyleDisplayName(name) };
}

/** The styles of `stylesXml`, each read as an XML parser reads it (see
 *  xmlElement), with its type, a paragraph style's where it has none, its
 *  ID and its name, where it has them, and its content */
function stylesOf(stylesXml: string): Array<{ start: number; end: number; tag: string; type: string; id: string | undefined; name: string | undefined; content: string }> {
  const styles = [];
  for (let style = xmlElement(stylesXml, 'w:style'); style; style = xmlElement(stylesXml, 'w:style', style.end)) {
    const nameTag = xmlStartTag(style.content, 'w:name');
    styles.push({
      start: style.start, end: style.end, tag: style.tag,
      type: xmlAttribute(style.tag, 'w:type') ?? 'paragraph',
      id: xmlAttribute(style.tag, 'w:styleId'),
      name: nameTag && xmlAttribute(nameTag.tag, 'w:val'),
      content: style.content,
    });
  }
  return styles;
}

/** What a style's content says of its formatting, as Word writes it, for
 *  comparing two: without its name, which names its copies apart, or its
 *  revision IDs (w:rsid), which Word adds as it saves, nor whitespace
 *  between its elements */
const styleFormatting = (content: string) => replaceXmlElements(content, ['w:name', 'w:rsid'], () => '').replace(/>\s+</g, '><').trim();

/** Whether a style of `stylesOf` is a copy of `own`, as Word saves it (see
 *  OwnStyle): of its type, with its ID whatever its case, or with its name,
 *  whatever its case, as Word compares names, or, for a `numbered` one, its
 *  name and digits, where its ID is export's and a suffix of letters and
 *  digits, whatever their case, as Word gives one, or it's formatted as
 *  export writes the style */
function isOwnStyleCopy(style: { type: string; id: string | undefined; name: string | undefined; content: string }, own: OwnStyle): boolean {
  if (style.type !== own.type || style.id === undefined) return false;
  const id = style.id.toLowerCase();
  const ownId = own.id.toLowerCase();
  if (id === ownId) return true;
  const name = style.name?.toLowerCase();
  const ownName = own.name.toLowerCase();
  if (name === ownName) return true;
  if (own.numbered === undefined || name === undefined || !name.startsWith(ownName) || !/^\d+$/.test(name.slice(ownName.length))) return false;
  return id.startsWith(ownId) && /^[a-z0-9]+$/.test(id.slice(ownId.length))
    || styleFormatting(style.content) === styleFormatting(xmlElement(own.numbered, 'w:style')?.content ?? '');
}

/** The w:style element of the first copy of `own` in `stylesXml` (see
 *  isOwnStyleCopy), of export's own ID first, where it starts, or undefined
 *  for none */
export function findOwnStyle(stylesXml: string, own: OwnStyle): { at: number; element: string } | undefined {
  const copies = stylesOf(stylesXml).filter(style => isOwnStyleCopy(style, own));
  const style = copies.find(copy => copy.id === own.id) ?? copies[0];
  return style && { at: style.start, element: stylesXml.slice(style.start, style.end) };
}

/** A template's styles with export's own, where it lacks them, and has no
 *  copy of them under another ID, as Word saves them (see OwnStyle) */
export function ensureManuscriptStyles(xml: string): string {
  for (const [own, style] of [[MANUSCRIPT_STYLES[0], LIST_CONTINUATION_STYLE_XML], [MANUSCRIPT_STYLES[1], RAW_HTML_STYLE_XML]] as const) {
    // One of any type of the ID itself, as it's found, is the style too, as
    // a template may give a style of its own export's ID
    if (!findStyleElement(xml, own.id, new Map(), true) && !findOwnStyle(xml, own)) xml = withStyleAdded(xml, style);
  }
  return xml;
}

/**
 * Styles XML with one of each style, as export writes them through a
 * template, and the IDs of the styles it left out or gave another ID, by
 * their types and IDs (`type + ' ' + id`), which references to them in the
 * other parts take instead (see withStyleReferences).
 *
 * Of each of export's own styles, `own`, the copies Word left under other
 * IDs and names (see OwnStyle) become one, of export's ID, which the
 * document's runs and paragraphs refer to: the one of that ID, where export
 * wrote or replaced it, or else the first, as the template's, whose
 * formatting the user may have changed, with that ID. The template's other
 * styles stay as they are, those whose IDs differ only in case too, as a
 * numbering style `List` beside `list`, which numbering refers to by its ID
 * (w:numStyleLink), and those of other types that share an ID or a name, as
 * a paragraph style and the character style linked to it may. What's left
 * between the styles, whitespace or a comment, stays.
 */
export function withStylesOnce(stylesXml: string, own: OwnStyle[]): { xml: string; ids: Map<string, string> } {
  const styles = stylesOf(stylesXml);
  const dropped = new Set<number>();
  const retagged = new Map<number, string>();
  const ids = new Map<string, string>();
  for (const style of own) {
    const copies = styles.flatMap((candidate, index) => isOwnStyleCopy(candidate, style) ? [index] : []);
    if (copies.length === 0) continue;
    const kept = copies.find(index => styles[index].id === style.id) ?? copies[0];
    for (const index of copies) {
      if (index !== kept) dropped.add(index);
      if (styles[index].id !== style.id) ids.set(style.type + ' ' + styles[index].id, style.id);
    }
    if (styles[kept].id !== style.id) retagged.set(kept, style.id);
  }
  if (dropped.size === 0 && retagged.size === 0) return { xml: stylesXml, ids };
  let xml = '';
  let at = 0;
  styles.forEach((style, index) => {
    if (dropped.has(index)) {
      xml += stylesXml.slice(at, style.start);
      at = style.end;
    } else if (retagged.has(index)) {
      xml += stylesXml.slice(at, style.start) + withXmlAttribute(style.tag, 'w:styleId', retagged.get(index)!);
      at = style.start + style.tag.length;
    }
  });
  xml += stylesXml.slice(at);
  // The styles left refer to those that went, as their base, next style or
  // link, by the ID of the one that stayed
  return { xml: withStyleReferences(xml, (id, type) => ids.get(type + ' ' + id)), ids };
}

export function applyAlertColorsToTemplate(stylesXml: string, scheme: ColorScheme): string {
  const colors = alertColorsByScheme(scheme);
  // What the styles are now changes, and the records of their tracked
  // changes go as they were
  const records = setRecordsAside(stylesXml);
  let xml = records.xml;

  for (const [styleId, alertType] of Object.entries(ALERT_STYLE_ID_TO_TYPE)) {
    // Each element read as an XML parser reads it (see xmlElement)
    const style = templateStyleParts(xml, styleId, new Map());
    if (!style) continue;

    // Replace w:color on the w:left border element
    let innerContent = style.content;
    const left = xmlStartTag(innerContent, 'w:left');
    if (left && /^[0-9A-Fa-f]{6}$/.test(xmlAttribute(left.tag, 'w:color') ?? '')) {
      innerContent = innerContent.slice(0, left.start) + withXmlAttribute(left.tag, 'w:color', colors[alertType]) + innerContent.slice(left.end);
    }

    xml = xml.slice(0, style.start) + style.open + innerContent + style.close + xml.slice(style.end);
  }

  return records.restore(xml);
}

/** Convert a user-defined style name to a Word style ID: 'my-heading' → 'MsCustomMyHeading'. */
export function customStyleId(name: string): string {
  return ('MsCustom' + name
    .split(/[-_\s]+/)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join('')
  ).replace(/[^A-Za-z0-9]/g, '');
}

/** Convert a user-defined style name to a Word display name: 'my-heading' → 'Custom: my-heading'. */
function customStyleDisplayName(name: string): string {
  return 'Custom: ' + name;
}

/**
 * Generate OOXML for a custom paragraph style definition, based on Normal.
 * Its font style, where it has one, is the whole of it: `normalTurnsOn` says
 * what a template's Normal turns on, which the style turns off where its font
 * style leaves it out. `szPairFn` writes its size: without a template,
 * nothing where export's Normal gives the same, which is redundant and Word
 * strips (dirty-flag invariant #5); with one, the size as it's given, as
 * the template's Normal may take its size from where import, without the
 * custom properties, doesn't read it. Import reads the size back from the
 * custom properties.
 */
function customStyleXml(
  name: string,
  def: import('./frontmatter').CustomStyleDef,
  bodyFontStr: string,
  szPairFn: (hp: number) => string,
  normalTurnsOn: (property: FontStyleProperty) => boolean = () => false,
): string {
  const styleId = customStyleId(name);
  const displayName = customStyleDisplayName(name);

  // pPr: spacing + indent + center alignment (ordering: spacing → ind → jc)
  let spacingParts = '';
  const beforeTwips = def.spacingBefore !== undefined ? Math.round(def.spacingBefore * 20) : undefined;
  const afterTwips = def.spacingAfter !== undefined ? Math.round(def.spacingAfter * 20) : undefined;
  if (beforeTwips !== undefined && beforeTwips !== 0) spacingParts += ' w:before="' + beforeTwips + '"';
  if (afterTwips !== undefined) spacingParts += ' w:after="' + afterTwips + '"';
  const spacingEl = spacingParts ? '<w:spacing' + spacingParts + '/>' : '';
  const indentEl = def.paragraphIndent !== undefined
    ? '<w:ind w:firstLine="' + (def.paragraphIndent === 'none' ? '0' : Math.round(def.paragraphIndent * 1440)) + '"/>'
    : '';
  const fontStyleElement = (property: FontStyleProperty) => def.fontStyle === undefined ? ''
    : property.wanted(def.fontStyle) ? property.on : normalTurnsOn(property) ? property.off : '';
  const jcEl = fontStyleElement(FONT_STYLE_CENTERING);
  const pPr = (spacingEl || indentEl || jcEl) ? '<w:pPr>' + spacingEl + indentEl + jcEl + '</w:pPr>\n' : '';

  // rPr: style flags, font and size, in schema order (see orderRPr)
  const styleStr = FONT_STYLE_RUN_PROPERTIES.map(fontStyleElement).join('');
  const fontStr = def.font
    ? '<w:rFonts w:ascii="' + escapeXmlAttribute(def.font) + '" w:hAnsi="' + escapeXmlAttribute(def.font) + '"/>'
    : bodyFontStr;
  const szStr = def.fontSize !== undefined ? szPairFn(Math.round(def.fontSize * 2)) : '';
  const rPrInner = orderRPr(styleStr + fontStr + szStr);
  const rPr = rPrInner ? '<w:rPr>' + rPrInner + '</w:rPr>\n' : '';

  return '<w:style w:type="paragraph" w:customStyle="1" w:styleId="' + styleId + '">\n' +
    '<w:name w:val="' + escapeXmlAttribute(displayName) + '"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    pPr + rPr +
    '</w:style>\n';
}

export function stylesXml(overrides?: FontOverrides, codeBlockConfig?: CodeBlockConfig, colorScheme?: ColorScheme, customStyles?: Record<string, import('./frontmatter').CustomStyleDef>, lineSpacingFm?: string | number, indentMode?: boolean, bibliographyHangingIndent?: boolean): string {
  const alertColors = alertColorsByScheme(colorScheme ?? getDefaultColorScheme());
  // Helper: build w:rFonts element for a given font name
  function rFonts(font: string): string {
    return '<w:rFonts w:ascii="' + escapeXmlAttribute(font) + '" w:hAnsi="' + escapeXmlAttribute(font) + '"/>';
  }

  // Helper: build w:sz + w:szCs elements for a given half-point size
  function szPair(hp: number): string {
    return '<w:sz w:val="' + hp + '"/><w:szCs w:val="' + hp + '"/>';
  }

  // Resolve body font rFonts string (empty if no override)
  const bodyFontStr = overrides?.bodyFont ? rFonts(overrides.bodyFont) : '';
  // The table paragraph style's font (see tableStyleFont)
  const tableFont = overrides && tableStyleFont(overrides);
  const codeFontStr = rFonts(codeFontName(overrides));

  // Normal style: body font + body size (default 22hp)
  const normalSz = overrides?.bodySizeHp
    ? szPair(overrides.bodySizeHp)
    : szPair(22);
  const normalRpr = '<w:rPr>' + bodyFontStr + normalSz + '</w:rPr>\n';
  // A heading's or the title's size, but not one it takes from Normal anyway,
  // which is redundant and Word strips — see dirty-flag invariant #5
  const sizeOverNormal = (hp: number | null | undefined) => hp && hp !== (overrides?.bodySizeHp || 22) ? szPair(hp) : '';

  // Heading helper: per-heading font/style/size overrides with defaults.
  // Pass null for defaultHp when the size matches the base style (Normal) to
  // avoid emitting redundant sz that Word strips — see dirty-flag invariant #5.
  function headingRpr(styleId: string, defaultHp: number | null): string {
    const font = overrides?.headingFonts?.get(styleId)
      ? rFonts(overrides.headingFonts.get(styleId)!)
      : bodyFontStr;
    const sz = sizeOverNormal(overrides?.headingSizesHp?.get(styleId) ?? defaultHp);
    const style = overrides?.headingStyles?.get(styleId);
    let styleStr: string;
    if (style === 'normal') {
      styleStr = '';
    } else if (style) {
      styleStr = '';
      if (style.includes('bold')) styleStr += '<w:b/>';
      if (style.includes('italic')) styleStr += '<w:i/>';
      if (style.includes('underline')) styleStr += '<w:u w:val="single"/>';
      // smallcaps/allcaps: use else-if because 'smallcaps' contains 'allcaps' as a substring
      if (style.includes('smallcaps')) styleStr += '<w:smallCaps/>';
      else if (style.includes('allcaps')) styleStr += '<w:caps/>';
    } else {
      styleStr = '<w:b/>';
    }
    // Heading 4, normal, in the body font and size, changes nothing. In
    // schema order (see orderRPr)
    const rPrInner = orderRPr(styleStr + font + sz);
    return rPrInner ? '<w:rPr>' + rPrInner + '</w:rPr>\n' : '';
  }

  /** Return '<w:jc w:val="center"/>' if the heading style includes center, else ''. */
  function headingJc(styleId: string): string {
    const style = overrides?.headingStyles?.get(styleId);
    return style && style.includes('center') ? '<w:jc w:val="center"/>' : '';
  }

  // CodeChar: code font only (no size override for character style)
  const isInsetMode = codeBlockConfig?.insetMode ?? false;
  const codeBg = isInsetMode ? undefined : (codeBlockConfig?.background || DEFAULT_CODE_BACKGROUND);
  const codeFontColor = codeBlockConfig?.codeFontColor || (isInsetMode ? undefined : DEFAULT_CODE_COLOR);
  const codeBorderSize = isInsetMode ? undefined : (codeBlockConfig?.codeBlockInset || DEFAULT_CODE_BORDER_SIZE);
  
  let codeCharRprInner = codeFontStr;
  if (codeFontColor) {
    codeCharRprInner += '<w:color w:val="' + codeFontColor + '"/>';
  }
  if (codeBg) {
    codeCharRprInner += '<w:shd w:val="clear" w:color="auto" w:fill="' + codeBg + '"/>';
  }
  const codeCharRpr = '<w:rPr>' + codeCharRprInner + '</w:rPr>\n';

  // CodeBlock: code font + code size (default 20hp)
  const codeBlockSz = overrides?.codeSizeHp
    ? szPair(overrides.codeSizeHp)
    : szPair(DEFAULT_CODE_BLOCK_HP);
  let codeBlockRprInner = codeFontStr;
  if (codeFontColor) {
    codeBlockRprInner += '<w:color w:val="' + codeFontColor + '"/>';
  }
  codeBlockRprInner += codeBlockSz;
  const codeBlockRpr = '<w:rPr>' + codeBlockRprInner + '</w:rPr>\n';

  // Title: title-specific font/size/style overrides, falling back to body font
  const titleFont = overrides?.titleFonts?.[0]
    ? rFonts(overrides.titleFonts[0])
    : bodyFontStr;
  const titleSz = sizeOverNormal(overrides?.titleSizesHp?.[0] || overrides?.headingSizesHp?.get('Title') || 56);
  let titleStyleStr = '';
  const titleStyle0 = overrides?.titleStyles?.[0];
  if (titleStyle0 === 'normal') {
    titleStyleStr = '';
  } else if (titleStyle0) {
    if (titleStyle0.includes('bold')) titleStyleStr += '<w:b/>';
    if (titleStyle0.includes('italic')) titleStyleStr += '<w:i/>';
    if (titleStyle0.includes('underline')) titleStyleStr += '<w:u w:val="single"/>';
    if (titleStyle0.includes('smallcaps')) titleStyleStr += '<w:smallCaps/>';
    else if (titleStyle0.includes('allcaps')) titleStyleStr += '<w:caps/>';
  }
  const titleRprInner = orderRPr(titleStyleStr + titleFont + titleSz);
  const titleRpr = titleRprInner ? '<w:rPr>' + titleRprInner + '</w:rPr>\n' : '';

  // FootnoteText: body font + size from heading map or default 20hp
  const footnoteSz = overrides?.headingSizesHp?.has('FootnoteText')
    ? szPair(overrides.headingSizesHp.get('FootnoteText')!)
    : szPair(20);
  const footnoteRpr = '<w:rPr>' + bodyFontStr + footnoteSz + '</w:rPr>\n';

  // EndnoteText: body font + size from heading map or default 20hp
  const endnoteSz = overrides?.headingSizesHp?.has('EndnoteText')
    ? szPair(overrides.headingSizesHp.get('EndnoteText')!)
    : szPair(20);
  const endnoteRpr = '<w:rPr>' + bodyFontStr + endnoteSz + '</w:rPr>\n';

  // Quote: body font only (no explicit size — inherits from Normal)
  const quoteRpr = bodyFontStr
    ? '<w:rPr>' + bodyFontStr + '</w:rPr>\n'
    : '';

  // IntenseQuote: body font + existing italic/color, in schema order, the
  // font first (dirty-flag invariant #4)
  const intenseQuoteRpr = '<w:rPr>' + orderRPr('<w:i/><w:color w:val="4472C4"/>' + bodyFontStr) + '</w:rPr>\n';
  function githubAlertStyle(styleId: string, displayName: string, borderColor: string): string {
    return '<w:style w:type="paragraph" w:customStyle="1" w:styleId="' + styleId + '">\n' +
      '<w:name w:val="' + displayName + '"/>\n' +
      '<w:basedOn w:val="Normal"/>\n' +
      '<w:pPr><w:pBdr><w:left w:val="single" w:sz="' + GITHUB_BLOCKQUOTE_BORDER_SIZE + '" w:space="' + GITHUB_BLOCKQUOTE_BORDER_SPACE + '" w:color="' + borderColor + '"/></w:pBdr><w:spacing w:after="0" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/><w:ind w:left="' + GITHUB_BLOCKQUOTE_INDENT + '"/></w:pPr>\n' +
      (quoteRpr ? quoteRpr : '') +
      '</w:style>\n';
  }

  // CodeBlock pPr: conditional inset vs shading mode
  let codeBlockPPr: string;
  if (isInsetMode) {
    codeBlockPPr = '<w:pPr><w:spacing w:after="0" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/><w:ind w:left="' + CODE_BLOCK_INSET_TWIPS + '" w:right="' + CODE_BLOCK_INSET_TWIPS + '"/></w:pPr>\n';
  } else {
    codeBlockPPr = '<w:pPr><w:pBdr>' +
      '<w:top w:val="single" w:sz="' + codeBorderSize + '" w:space="' + CODE_BORDER_SPACE + '" w:color="' + codeBg + '"/>' +
      '<w:left w:val="single" w:sz="' + codeBorderSize + '" w:space="' + CODE_BORDER_SPACE + '" w:color="' + codeBg + '"/>' +
      '<w:bottom w:val="single" w:sz="' + codeBorderSize + '" w:space="' + CODE_BORDER_SPACE + '" w:color="' + codeBg + '"/>' +
      '<w:right w:val="single" w:sz="' + codeBorderSize + '" w:space="' + CODE_BORDER_SPACE + '" w:color="' + codeBg + '"/>' +
      '</w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="' + codeBg + '"/>' +
      '<w:spacing w:after="0" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/>' +
      '<w:ind w:left="' + CODE_BLOCK_MARGIN_INDENT + '" w:right="' + CODE_BLOCK_MARGIN_INDENT + '"/></w:pPr>\n';
  }

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:styles xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml" xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du" xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash" xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex" mc:Ignorable="w14 w15 w16se w16cid w16 w16cex w16sdtdh w16du">\n' +
    '<w:docDefaults>\n' +
    '<w:rPrDefault><w:rPr>' +
    '<w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/>' +
    '<w:kern w:val="2"/><w:sz w:val="24"/><w:szCs w:val="24"/>' +
    '<w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/>' +
    '<w14:ligatures w14:val="standardContextual"/>' +
    '</w:rPr></w:rPrDefault>\n' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="' + resolveLineSpacingTwips(lineSpacingFm) + '" w:lineRule="auto"/></w:pPr></w:pPrDefault>\n' +
    '</w:docDefaults>\n' +
    LATENT_STYLES + '\n' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">\n' +
    '<w:name w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:after="' + (indentMode ? '0' : '200') + '" w:line="' + resolveLineSpacingTwips(lineSpacingFm) + '" w:lineRule="auto"/></w:pPr>\n' +
    normalRpr +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading1">\n' +
    '<w:name w:val="heading 1"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:before="240" w:after="0"/>' + headingJc('Heading1') + '<w:outlineLvl w:val="0"/></w:pPr>\n' +
    headingRpr('Heading1', 32) +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading2">\n' +
    '<w:name w:val="heading 2"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:before="200" w:after="0"/>' + headingJc('Heading2') + '<w:outlineLvl w:val="1"/></w:pPr>\n' +
    headingRpr('Heading2', 26) +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading3">\n' +
    '<w:name w:val="heading 3"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:before="200" w:after="0"/>' + headingJc('Heading3') + '<w:outlineLvl w:val="2"/></w:pPr>\n' +
    headingRpr('Heading3', 24) +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading4">\n' +
    '<w:name w:val="heading 4"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:after="0"/>' + headingJc('Heading4') + '<w:outlineLvl w:val="3"/></w:pPr>\n' +
    headingRpr('Heading4', null) +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading5">\n' +
    '<w:name w:val="heading 5"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:after="0"/>' + headingJc('Heading5') + '<w:outlineLvl w:val="4"/></w:pPr>\n' +
    headingRpr('Heading5', 20) +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Heading6">\n' +
    '<w:name w:val="heading 6"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:after="0"/>' + headingJc('Heading6') + '<w:outlineLvl w:val="5"/></w:pPr>\n' +
    headingRpr('Heading6', 18) +
    '</w:style>\n' +
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont">\n' +
    '<w:name w:val="Default Paragraph Font"/>\n' +
    '<w:uiPriority w:val="1"/>\n' +
    '<w:semiHidden/>\n' +
    '<w:unhideWhenUsed/>\n' +
    '</w:style>\n' +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal">\n' +
    '<w:name w:val="Normal Table"/>\n' +
    '<w:uiPriority w:val="99"/>\n' +
    '<w:semiHidden/>\n' +
    '<w:unhideWhenUsed/>\n' +
    '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="numbering" w:default="1" w:styleId="NoList">\n' +
    '<w:name w:val="No List"/>\n' +
    '<w:uiPriority w:val="99"/>\n' +
    '<w:semiHidden/>\n' +
    '<w:unhideWhenUsed/>\n' +
    '</w:style>\n' +
    '<w:style w:type="character" w:styleId="Hyperlink">\n' +
    '<w:name w:val="Hyperlink"/>\n' +
    '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Quote">\n' +
    '<w:name w:val="Quote"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:ind w:left="720"/></w:pPr>\n' +
    (quoteRpr ? quoteRpr : '') +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="IntenseQuote">\n' +
    '<w:name w:val="Intense Quote"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="4" w:color="4472C4"/></w:pBdr><w:ind w:left="720"/></w:pPr>\n' +
    intenseQuoteRpr +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:customStyle="1" w:styleId="GitHubBlockquote">\n' +
    '<w:name w:val="GitHub Blockquote"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:pBdr><w:left w:val="single" w:sz="' + GITHUB_BLOCKQUOTE_BORDER_SIZE + '" w:space="' + GITHUB_BLOCKQUOTE_BORDER_SPACE + '" w:color="' + GITHUB_BLOCKQUOTE_BORDER_COLOR + '"/></w:pBdr><w:spacing w:after="0" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/><w:ind w:left="' + GITHUB_BLOCKQUOTE_INDENT + '"/></w:pPr>\n' +
    (quoteRpr ? quoteRpr : '') +
    '</w:style>\n' +
    LIST_CONTINUATION_STYLE_XML +
    RAW_HTML_STYLE_XML +
    githubAlertStyle('GitHubNote', 'GitHub Note', alertColors.note) +
    githubAlertStyle('GitHubTip', 'GitHub Tip', alertColors.tip) +
    githubAlertStyle('GitHubImportant', 'GitHub Important', alertColors.important) +
    githubAlertStyle('GitHubWarning', 'GitHub Warning', alertColors.warning) +
    githubAlertStyle('GitHubCaution', 'GitHub Caution', alertColors.caution) +
    '<w:style w:type="character" w:customStyle="1" w:styleId="CodeChar">\n' +
    '<w:name w:val="Code Char"/>\n' +
    codeCharRpr +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:customStyle="1" w:styleId="CodeBlock">\n' +
    '<w:name w:val="Code Block"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    codeBlockPPr +
    codeBlockRpr +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="Title">\n' +
    '<w:name w:val="Title"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:after="300"/>' + (titleStyle0 && titleStyle0.includes('center') ? '<w:jc w:val="center"/>' : '') + '</w:pPr>\n' +
    titleRpr +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="FootnoteText">\n' +
    '<w:name w:val="footnote text"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    footnoteRpr +
    '</w:style>\n' +
    '<w:style w:type="character" w:styleId="FootnoteReference">\n' +
    '<w:name w:val="footnote reference"/>\n' +
    '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="EndnoteText">\n' +
    '<w:name w:val="endnote text"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    endnoteRpr +
    '</w:style>\n' +
    '<w:style w:type="character" w:styleId="EndnoteReference">\n' +
    '<w:name w:val="endnote reference"/>\n' +
    '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>\n' +
    '</w:style>\n' +
    // TableParagraph: table-specific font/size style (only when overrides exist)
    (overrides?.tableSizeHp || overrides?.tableFont
      ? '<w:style w:type="paragraph" w:customStyle="1" w:styleId="TableParagraph">\n' +
        '<w:name w:val="Table Paragraph"/>\n' +
        '<w:basedOn w:val="Normal"/>\n' +
        '<w:rPr>' +
        (tableFont ? tableRFonts(tableFont) : '') +
        (overrides.tableSizeHp ? szPair(overrides.tableSizeHp) : '') +
        '</w:rPr>\n' +
        '</w:style>\n'
      : '') +
    '<w:style w:type="character" w:styleId="CommentReference">\n' +
    '<w:name w:val="annotation reference"/>\n' +
    '<w:basedOn w:val="DefaultParagraphFont"/>\n' +
    '<w:uiPriority w:val="99"/>\n' +
    '<w:semiHidden/>\n' +
    '<w:unhideWhenUsed/>\n' +
    '<w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr>\n' +
    '</w:style>\n' +
    '<w:style w:type="paragraph" w:styleId="CommentText">\n' +
    '<w:name w:val="annotation text"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:uiPriority w:val="99"/>\n' +
    '<w:semiHidden/>\n' +
    '<w:unhideWhenUsed/>\n' +
    '<w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr>\n' +
    '<w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>\n' +
    '</w:style>\n' +
    // Append user-defined custom styles (deduplicate by style ID to avoid collisions)
    (customStyles
      ? (() => {
          const seenIds = new Set<string>();
          return Object.entries(customStyles)
            .filter(([name]) => {
              const sid = customStyleId(name);
              if (seenIds.has(sid)) return false;
              seenIds.add(sid);
              return true;
            })
            .map(([name, def]) => customStyleXml(name, def, bodyFontStr, sizeOverNormal))
            .join('');
        })()
      : '') +
    '<w:style w:type="paragraph" w:styleId="Bibliography">\n' +
    '<w:name w:val="Bibliography"/>\n' +
    '<w:basedOn w:val="Normal"/>\n' +
    '<w:pPr><w:spacing w:after="200" w:line="' + SINGLE_LINE_SPACING + '" w:lineRule="auto"/>' +
    (bibliographyHangingIndent !== false ? '<w:ind w:left="720" w:hanging="720"/>' : '') +
    '</w:pPr>\n' +
    '</w:style>\n' +
    '</w:styles>';
}
