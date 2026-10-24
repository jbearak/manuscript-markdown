// The page and section properties export writes (w:sectPr): the page's size,
// margins and orientation, a template's sections, and columns, and the width
// of the text they leave, which tables and images are fitted to. Split out of
// md-to-docx.ts, whose header's invariants hold here too.
import { type Context, EXPORT_CONTEXT, EXPORT_IGNORABLE, EXPORT_NAMESPACES, MARKUP_COMPATIBILITY, type Scope, WORDPROCESSINGML, type XmlNode, attributeNamed, attributesOf, buildOrdered, childrenOf, contextIn, effectiveSectPr, elementsIn, isElement, isNamed, mapProperties, moved, nameOf, parseOrdered, scopeIn, sectPrPropertyOf, sectPrRank, withProperties } from './scoped-xml';
import type { DocxGenState } from './md-to-docx';
import { type TemplateSections, withTemplateSection } from './template-sections';
import { escapeXmlAttribute } from './xml-parser';
import { xmlOn, xmlTwips } from './xml-elements';

// --- Landscape section helpers ---
// US Letter defaults in twips (twentieths of a point)
const DEFAULT_PAGE_W = 12240; // 8.5in
const DEFAULT_PAGE_H = 15840; // 11in
const DEFAULT_MARGINS = 'w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"';

interface PageSize { w: number; h: number }

/** Whether the current section's page is on its side: a landscape
 *  section's, or the last section's, which keeps the template's own page
 *  (see bodyClosingSectPrXml), where that's landscape. A section a break
 *  ends before a fence has an upright page (see sectionBreakSectPrXml). A
 *  note's is the page it's on (see noteSectionLandscape). */
export function sectionIsLandscape(state: DocxGenState): boolean {
  if (state.noteSectionLandscape !== undefined) return state.noteSectionLandscape;
  return state.inLandscapeSection || !state.inPortraitSection && !!state.inLastSection
    && !!state.templateSectPr && isLandscapeSectPr(state.templateSectPr);
}

/** Return the writable width of the current section in CSS pixels (96 px/in):
 *  its narrowest column's, as each section has the template's columns, or a
 *  footnote's column's (see writableWidthTwips). */
export function pageContentWidthPx(state: DocxGenState): number {
  const pgSz = parseTemplatePgSz(state.templateSectPr);
  const margins = parseTemplateMargins(state.templateSectPr);
  const pageWidthTwips = sectionIsLandscape(state) ? pgSz.h : pgSz.w;
  // 1 inch = 1440 twips = 96 CSS pixels.
  return Math.max(1, writableWidthTwips(state, textWidthTwips(pageWidthTwips, margins)) / 15);
}

// Word's narrowest column, half an inch, in twips
const NARROWEST_COLUMN = 720;

/** An element, as a sectPr's child, with the scope it's in */
type InScope = { node: XmlNode; scope: Scope };

/** An element's attribute in WordprocessingML's namespace, whatever its prefix */
export const wAttributeOf = ({ node, scope }: InScope, local: string) => attributeNamed(node, scope, WORDPROCESSINGML, local);

/**
 * A sectPr's w:cols as a section of a text width, in twips, has them, and
 * the width of its narrowest column. Its columns are of their own widths,
 * those its w:col children give, where w:equalWidth is off, and else of
 * equal width, as Word reads a w:cols with no w:equalWidth ([MS-OI29500]
 * Part 1 Section 17.6.4, b): the text width shared by w:num columns
 * w:space apart, one and 720 if not given (ECMA-376 Part 1 §17.6.4). They
 * stay as they are where they fit. Columns of their own widths, with the
 * spaces after them, that add up to more than the text, as a landscape
 * template's can on an upright page, are scaled down to it. Where columns
 * would be narrower than Word's narrowest, as equal ones far apart for a
 * landscape page can be on an upright one, the section has one column.
 * The w:cols is as Word reads it (see resolvedSectPr), with no
 * alternatives in it.
 */
function fitColumns(cols: InScope, textWidth: number): { cols: InScope; narrowest: number } {
  const one = { cols: { node: ONE_COLUMN, scope: EXPORT_NAMESPACES }, narrowest: textWidth };
  const twips = (col: InScope, name: string) => Math.max(0, xmlTwips(wAttributeOf(col, name)) ?? 0);
  const own = elementsIn(cols.node, cols.scope).filter(col => sectPrPropertyOf(col.node, col.scope) === 'col');
  const equalWidth = wAttributeOf(cols, 'equalWidth');
  if (own.length > 0 && equalWidth !== undefined && !xmlOn(equalWidth)) {
    // The space after each column but the last, which has none
    const total = own.reduce((sum, col, i) => sum + twips(col, 'w') + (i < own.length - 1 ? twips(col, 'space') : 0), 0);
    const scale = Math.min(1, textWidth / total);
    const narrowest = own.reduce((least, col) => Math.min(least, Math.floor(twips(col, 'w') * scale)), Infinity);
    if (narrowest < NARROWEST_COLUMN) return one;
    if (scale === 1) return { cols, narrowest };
    // Each scaled in twips, whatever the template's unit
    const scaled = (col: XmlNode, scope: Scope): XmlNode => {
      const attributes = { ...col[':@'] };
      for (const { key, namespace, local, value } of attributesOf(col, scope)) {
        if (namespace !== undefined && WORDPROCESSINGML.has(namespace) && (local === 'w' || local === 'space')) attributes[key] = String(Math.floor((xmlTwips(value) ?? 0) * scale));
      }
      return { ...col, ':@': attributes };
    };
    const inner = scopeIn(cols.node, cols.scope);
    return { cols: { node: { ...cols.node, [nameOf(cols.node)]: childrenOf(cols.node).map(child => sectPrPropertyOf(child, inner) === 'col' ? scaled(child, inner) : child) }, scope: cols.scope }, narrowest };
  }
  const num = Math.max(1, parseInt(wAttributeOf(cols, 'num') ?? '', 10) || 1);
  const narrowest = (textWidth - (num - 1) * (xmlTwips(wAttributeOf(cols, 'space')) ?? 720)) / num;
  return num === 1 || narrowest >= NARROWEST_COLUMN ? { cols, narrowest } : one;
}

/** The columns a section of a text width, in twips, has of a sectPr's own
 *  w:cols, as Word reads them, fitted to it (see fitColumns), and the
 *  width of the narrowest, or one column, the text's width, where it has
 *  none */
function sectionColumns(sectPrXml: string | undefined, textWidth: number): { cols: InScope; narrowest: number } {
  const cols = sectPrPropertyIn(sectPrXml, 'cols');
  return cols ? fitColumns(cols, textWidth) : { cols: { node: ONE_COLUMN, scope: EXPORT_NAMESPACES }, narrowest: textWidth };
}

// The namespace of Word 2013's extensions to WordprocessingML, w15
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';

/** The width, in twips, of what's written in a section of a text width,
 *  from the columns the section has (see sectionColumns): its narrowest
 *  column, or, in a footnote, where the template lays footnotes out in
 *  columns of their own, w15:footnoteColumns, one of those, equal, as far
 *  apart as the section's columns are, or the text width where they'd be
 *  narrower than Word's narrowest. Endnotes are in the section's columns */
export function writableWidthTwips(state: DocxGenState, textWidth: number): number {
  const { cols, narrowest } = sectionColumns(state.templateSectPr, textWidth);
  const sectPr = state.inNoteBody && state.notesMode !== 'endnotes' && state.templateSectPr ? resolvedSectPr(state.templateSectPr) : undefined;
  const footnoteColumns = sectPr && elementsIn(sectPr, EXPORT_NAMESPACES).find(child => isNamed(child.node, child.scope, W15, 'footnoteColumns'));
  const num = footnoteColumns ? parseInt(wAttributeOf(footnoteColumns, 'val') ?? '', 10) : NaN;
  // None, or 0, is as many as the section's
  if (!(num >= 1)) return narrowest;
  const footnoteColumn = (textWidth - (num - 1) * (xmlTwips(wAttributeOf(cols, 'space')) ?? 720)) / num;
  return num === 1 || footnoteColumn >= NARROWEST_COLUMN ? footnoteColumn : textWidth;
}

/** The width of a page's text between the margins given, in twips, and
 *  without the binding gutter they give, none by default, which Word adds
 *  beside the left margin, or the right one, as w:rtlGutter has it, but
 *  never at the top, as only the template's settings, which export doesn't
 *  take, can put it (w:gutterAtTop) */
export function textWidthTwips(pageWidth: number, margins: string): number {
  // As export's document reads them
  const pgMar = parseOrdered('<w:pgMar ' + margins + '/>')?.[0];
  const margin = (side: string, otherwise: number) => xmlTwips(pgMar && attributeNamed(pgMar, EXPORT_NAMESPACES, WORDPROCESSINGML, side)) ?? otherwise;
  return pageWidth - margin('left', 1440) - margin('right', 1440) - Math.max(0, margin('gutter', 0));
}

/** A sectPr's own section property, by its local name, as Word reads it
 *  (see resolvedSectPr), with the scope it's in: its child, not an
 *  extension's that Word ignores, or a tracked change's old one, which its
 *  w:sectPrChange holds, or none */
export function sectPrPropertyIn(sectPrXml: string | undefined, property: string): InScope | undefined {
  const sectPr = sectPrXml ? resolvedSectPr(sectPrXml) : undefined;
  return sectPr && elementsIn(sectPr, EXPORT_NAMESPACES).find(child => sectPrPropertyOf(child.node, child.scope) === property);
}

/** Parse w:pgSz from a sectPr XML string, defaulting to US Letter portrait.
 *  Its own page (see sectPrPropertyIn). */
export function parseTemplatePgSz(sectPrXml: string | undefined): PageSize {
  const pgSz = sectPrPropertyIn(sectPrXml, 'pgSz');
  if (!pgSz) return { w: DEFAULT_PAGE_W, h: DEFAULT_PAGE_H };
  // In any unit a measure can give
  const w = xmlTwips(wAttributeOf(pgSz, 'w')) ?? DEFAULT_PAGE_W;
  const h = xmlTwips(wAttributeOf(pgSz, 'h')) ?? DEFAULT_PAGE_H;
  // Normalize to portrait (smaller value = width)
  return w <= h ? { w, h } : { w: h, h: w };
}

/** Whether a sectPr's page is landscape, as import reads it: turned, or
 *  wider than it's tall. Its own page (see sectPrPropertyIn) */
export function isLandscapeSectPr(sectPrXml: string): boolean {
  const pgSz = sectPrPropertyIn(sectPrXml, 'pgSz');
  if (!pgSz) return false;
  const w = xmlTwips(wAttributeOf(pgSz, 'w')) ?? 0;
  const h = xmlTwips(wAttributeOf(pgSz, 'h')) ?? 0;
  return wAttributeOf(pgSz, 'orient') === 'landscape' || w > 0 && h > 0 && w > h;
}

/** The attributes of a sectPr's margins, w:pgMar, as Word reads them (see
 *  effectiveSectPr), to write on margins of export's document, under
 *  export's prefixes, with the declarations and markup compatibility
 *  settings they use where the sectPr has them (see moved), as an
 *  extension's attribute that only the sectPr declares and makes
 *  ignorable. Its own margins, not a tracked change's old ones. */
export function parseTemplateMargins(sectPrXml: string | undefined): string {
  const parsed = sectPrXml ? parseOrdered(sectPrXml)?.find(isElement) : undefined;
  if (!parsed) return DEFAULT_MARGINS;
  const sectPr = effectiveSectPr(parsed, EXPORT_CONTEXT), inside = contextIn(sectPr, EXPORT_CONTEXT);
  const pgMar = childrenOf(sectPr).find(child => isElement(child) && sectPrPropertyOf(child, inside.scope) === 'pgMar');
  if (!pgMar) return DEFAULT_MARGINS;
  const margins = moved(pgMar, inside, EXPORT_CONTEXT);
  // Its attributes as the builder writes them, between its name and the
  // end of its empty tag
  const built = buildOrdered([{ [nameOf(margins)]: [], ':@': margins[':@'] }]);
  return built.slice(('<' + nameOf(margins)).length, -'/>'.length).trim();
}

/** The namespace declarations of a sectPr, and its markup compatibility
 *  attributes, as mc:Ignorable, which say how to read the namespaces its
 *  children use, each with its space before it */
function sectPrNamespaces(sectPr: XmlNode): string {
  const compatibility = new Set(attributesOf(sectPr, EXPORT_NAMESPACES).filter(({ namespace }) => namespace === MARKUP_COMPATIBILITY).map(({ key }) => key));
  return Object.entries(sectPr[':@'] ?? {}).filter(([key]) => key === '@_xmlns' || key.startsWith('@_xmlns:') || compatibility.has(key))
    .map(([key, value]) => ' ' + key.slice('@_'.length) + '="' + escapeXmlAttribute(value) + '"').join('');
}

// The start of export's document, whose namespaces, EXPORT_NAMESPACES, a
// template's sectPr, which goes in it, is read with
export const DOCUMENT_START = '<w:document' + [...EXPORT_NAMESPACES].map(([prefix, namespace]) => ' xmlns:' + prefix + '="' + namespace + '"').join('') + ' mc:Ignorable="' + EXPORT_IGNORABLE.join(' ') + '">';

/** A sectPr, parsed, as Word reads it in export's document (see
 *  effectiveSectPr): under export's prefixes, with each of markup
 *  compatibility's alternatives and wrappers in it in place of what Word
 *  reads of them, as Word writes it on save, and as each section export
 *  writes from it has them, so that each property is one, in its place,
 *  and its columns are those Word shows. None where it isn't a sectPr. */
function resolvedSectPr(sectPrXml: string): XmlNode | undefined {
  const sectPr = parseOrdered(sectPrXml)?.find(isElement);
  return sectPr && isNamed(sectPr, EXPORT_NAMESPACES, WORDPROCESSINGML, 'sectPr') ? effectiveSectPr(sectPr, EXPORT_CONTEXT) : undefined;
}

// The template's section properties a section break doesn't take: its own
// break and page; the headers, footers, title page and page number start
// only the first section takes (see withTemplateSectPrs); a tracked
// change's old properties; and the printer settings, which name a
// relationship of the template's
const NOT_COPIED = new Set(['type', 'pgSz', 'headerReference', 'footerReference', 'titlePg', 'pgNumType', 'sectPrChange', 'printerSettings']);
// The children CT_SectPr puts before w:type (ECMA-376 Part 1 §17.6.17)
const BEFORE_TYPE = new Set(['headerReference', 'footerReference', 'footnotePr', 'endnotePr']);
/** Whether CT_SectPr puts a section property after another */
const isAfter = (property: string, other: string) => sectPrRank(property) > sectPrRank(other);
// One column, as Word writes it
const ONE_COLUMN: XmlNode = parseOrdered('<w:cols w:space="720"/>')![0];

/** A sectPr's children with their columns fitted to this section's text
 *  width (see fitColumns), or with one column where they have none, which
 *  Word would add on open, marking the document changed (see dirty-flag
 *  invariant 11), before the children CT_SectPr puts after it */
function fittingColumns(children: InScope[], textWidth: number): XmlNode[] {
  const columns = children.findIndex(child => sectPrPropertyOf(child.node, child.scope) === 'cols');
  if (columns !== -1) return children.map((child, i) => i === columns ? fitColumns(child, textWidth).cols.node : child.node);
  const at = children.findIndex(child => isAfter(sectPrPropertyOf(child.node, child.scope), 'cols'));
  const nodes = children.map(child => child.node);
  return at === -1 ? [...nodes, ONE_COLUMN] : [...nodes.slice(0, at), ONE_COLUMN, ...nodes.slice(at)];
}

/** A template's sectPr, parsed, in export's document, with what Word adds
 *  to one that hasn't it on open, marking the document changed (see
 *  dirty-flag invariant 11), as a section break has it (see
 *  sectionBreakSectPrXml): `rsid` as its w:rsidR, after its declarations,
 *  and one column, among its properties in CT_SectPr's order (see
 *  withProperties). What it has stays, in its order, and one with both is
 *  the same node. */
function completedSectPr(sectPr: XmlNode, rsid?: string): XmlNode {
  // Its columns as Word reads them, in a wrapper whose content it reads too
  const effective = effectiveSectPr(sectPr, EXPORT_CONTEXT), inside = contextIn(effective, EXPORT_CONTEXT);
  const hasColumns = childrenOf(effective).some(child => sectPrPropertyOf(child, inside.scope) === 'cols');
  const columned = hasColumns ? sectPr : withProperties(sectPr, EXPORT_CONTEXT, [ONE_COLUMN], EXPORT_CONTEXT);
  if (!rsid || attributeNamed(sectPr, EXPORT_NAMESPACES, WORDPROCESSINGML, 'rsidR') !== undefined) return columned;
  const attributes = Object.entries(sectPr[':@'] ?? {});
  const others = new Set(attributesOf(sectPr, EXPORT_NAMESPACES).filter(({ namespace }) => namespace !== MARKUP_COMPATIBILITY).map(({ key }) => key));
  const first = attributes.findIndex(([key]) => others.has(key));
  const at = first === -1 ? attributes.length : first;
  return { ...columned, ':@': Object.fromEntries([...attributes.slice(0, at), ['@_w:rsidR', rsid], ...attributes.slice(at)]) };
}

/**
 * Build the sectPr of a section break, which ends a section on a new page,
 * the fence's orientation. With a template, it has the template's own
 * section properties, as Word gives a section it inserts the properties of
 * the one it splits, so each section has the template's columns, line
 * numbers, document grid and note settings, with the page turned. Without
 * one, a page of the size and margins given.
 */
export function sectionBreakSectPrXml(landscape: boolean, pgSz: PageSize, margins: string, rsid?: string, templateSectPr?: string): string {
  // Of markup compatibility's alternatives, those Word reads
  const sectPr = templateSectPr ? resolvedSectPr(templateSectPr) : undefined;
  // The namespaces the template's sectPr declares, which its children can
  // use, and how to read them
  const open = '<w:sectPr' + (sectPr ? sectPrNamespaces(sectPr) : '') + (rsid ? ' w:rsidR="' + rsid + '"' : '') + '>';
  const page = landscape ? '<w:pgSz w:w="' + pgSz.h + '" w:h="' + pgSz.w + '" w:orient="landscape"/>' : '<w:pgSz w:w="' + pgSz.w + '" w:h="' + pgSz.h + '"/>';
  // w:type goes before w:pgSz, as CT_SectPr orders them
  if (sectPr) {
    const property = (child: InScope) => sectPrPropertyOf(child.node, child.scope);
    const copied = elementsIn(sectPr, EXPORT_NAMESPACES).filter(child => !NOT_COPIED.has(property(child)));
    // The margins export fits the section's content to, one inch, where the
    // template has none of its own, right after the page, as CT_SectPr has them
    const pageMargins = copied.some(child => property(child) === 'pgMar') ? '' : '<w:pgMar ' + margins + '/>';
    // And columns that fit
    const after = fittingColumns(copied.filter(child => !BEFORE_TYPE.has(property(child))), textWidthTwips(landscape ? pgSz.h : pgSz.w, margins));
    return open + buildOrdered(copied.filter(child => BEFORE_TYPE.has(property(child))).map(child => child.node)) + '<w:type w:val="nextPage"/>' + page + pageMargins +
      buildOrdered(after) + '</w:sectPr>';
  }
  return open + '<w:type w:val="nextPage"/>' + page +
    '<w:pgMar ' + margins + '/>' +
    '<w:cols w:space="720"/></w:sectPr>';
}

/** The body and its closing sectPr with the template's page number format
 *  on each section, and its page number start, headers and footers on the
 *  first, in the body's order: the sections after it take them from it */
export function withTemplateSectPrs(body: string, closingSectPr: string, sections?: TemplateSections): { body: string; closingSectPr: string } {
  if (!sections) return { body, closingSectPr };
  let first = true;
  const withTemplate = (sectPr: string): string => {
    const decorated = withTemplateSection(sectPr, sections, first);
    first = false;
    return decorated;
  };
  body = body.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, withTemplate);
  return { body, closingSectPr: withTemplate(closingSectPr) };
}

/** Build the final body-level sectPr of a section a fence ends: the
 *  template's, as Word reads it (see resolvedSectPr), with its page turned
 *  to the fence's orientation, in place of its own w:pgSz, or where
 *  CT_SectPr puts one, as its other properties stay, but for columns,
 *  fitted to the turned page (see fitColumns), or else one of its own. Not
 *  an extension's page that Word ignores, nor one in a tracked change's old
 *  properties, w:sectPrChange, last, which hold a w:sectPr of their own. */
export function fencedBodySectPrXml(landscape: boolean, pgSz: PageSize, margins: string, templateSectPr?: string, rsid?: string): string {
  const fencePgSz = landscape ? '<w:pgSz w:w="' + pgSz.h + '" w:h="' + pgSz.w + '" w:orient="landscape"/>' : '<w:pgSz w:w="' + pgSz.w + '" w:h="' + pgSz.h + '"/>';
  const sectPr = templateSectPr ? resolvedSectPr(templateSectPr) : undefined;
  if (sectPr) {
    const scope = scopeIn(sectPr, EXPORT_NAMESPACES);
    const property = (child: XmlNode) => sectPrPropertyOf(child, scope);
    const children = childrenOf(sectPr), turned = parseOrdered(fencePgSz)![0];
    const page = children.findIndex(child => property(child) === 'pgSz');
    const after = children.findIndex(child => isAfter(property(child), 'pgSz'));
    const at = after === -1 ? children.length : after;
    const withPage = page !== -1 ? children.map((child, i) => i === page ? turned : child) : [...children.slice(0, at), turned, ...children.slice(at)];
    // Its columns fitted to the turned page
    const textWidth = textWidthTwips(landscape ? pgSz.h : pgSz.w, margins);
    return buildOrdered([completedSectPr({ ...sectPr, [nameOf(sectPr)]: withPage.map(child => property(child) === 'cols' ? fitColumns({ node: child, scope }, textWidth).cols.node : child) }, rsid)]);
  }
  return '<w:sectPr' + (rsid ? ' w:rsidR="' + rsid + '"' : '') + '>' + fencePgSz +
    '<w:pgMar ' + margins + '/>' +
    '<w:cols w:space="720"/></w:sectPr>';
}

// A section's break that starts it on a new page
const NEXT_PAGE: XmlNode = parseOrdered('<w:type w:val="nextPage"/>')![0];

/** A sectPr whose section starts on a new page: its w:type, and that of
 *  each of markup compatibility's alternatives in it, and of each wrapper
 *  whose content Word reads, whichever Word reads, nextPage, or none, which
 *  is a new page already. Not an extension's that Word ignores, nor a
 *  tracked change's old properties, which keep theirs (see mapProperties). */
export function nextPageSectPrXml(sectPrXml: string): string {
  const sectPr = parseOrdered(sectPrXml)?.find(isElement);
  if (!sectPr) return sectPrXml;
  const nextPage = (node: XmlNode, context: Context) => [sectPrPropertyOf(node, context.scope) === 'type' ? NEXT_PAGE : node];
  return buildOrdered([{ ...sectPr, [nameOf(sectPr)]: mapProperties(childrenOf(sectPr), contextIn(sectPr, EXPORT_CONTEXT), nextPage) }]);
}

/** Build the final body-level sectPr (no <w:type>, direct child of <w:body>). */
export function bodyClosingSectPrXml(pgSz: PageSize, margins: string, templateSectPr?: string, rsid?: string): string {
  // If we have a template sectPr, reuse it to preserve any additional
  // properties (columns, etc.), as it is where it has a w:rsidR and
  // columns, and else with them (see completedSectPr). It comes without
  // its headers, footers and page numbering, which withTemplateSectPrs
  // gives it
  if (templateSectPr) {
    const sectPr = parseOrdered(templateSectPr)?.find(isElement);
    if (!sectPr || !isNamed(sectPr, EXPORT_NAMESPACES, WORDPROCESSINGML, 'sectPr')) return templateSectPr;
    const completed = completedSectPr(sectPr, rsid);
    return completed === sectPr ? templateSectPr : buildOrdered([completed]);
  }
  return '<w:sectPr' + (rsid ? ' w:rsidR="' + rsid + '"' : '') + '><w:pgSz w:w="' + pgSz.w + '" w:h="' + pgSz.h + '"/>' +
    '<w:pgMar ' + margins + '/>' +
    '<w:cols w:space="720"/></w:sectPr>';
}
