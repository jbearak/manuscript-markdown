// Finding a style in styles.xml as Word does, for import, which reads a
// document's styles, and for export, which reads and changes a template's.
// Both find a style by the same reader, so that what export makes of a
// template's style is what import reads back from it.

import { xmlAttribute, xmlElement } from './xml-elements';

/**
 * The w:style element of the paragraph style `id` in `stylesXml`, as it is,
 * and where it starts, or undefined for none. A built-in style is found by
 * `ids`' ID for it, the document's or template's where Word in another
 * language gives it another, as `berschrift1` for `Heading1` (see
 * StyleLayouts.builtInIds in converter.ts and templateStyleIds in
 * md-to-docx.ts). Else it's the style of the ID itself, or else one whose ID
 * differs only in case, as Word matches a style's ID whatever its case, as
 * `heading1`, but not one of another type, which a paragraph doesn't take,
 * as a character style `Normal`. With `anyType`, as for a custom style,
 * which can be a character style, the style of the ID itself is of any
 * type. Its tags are read as an XML parser reads them (see xmlElement), with
 * whitespace around an attribute's = and its value in either quotes, so a
 * style written as <w:style .../> is its tag alone, and the next </w:style>
 * closes another.
 */
export function findStyleElement(stylesXml: string, id: string, ids: Map<string, string>, anyType = false): { at: number; element: string } | undefined {
  const styleId = ids.get(id) ?? id;
  let caseless: { at: number; element: string } | undefined;
  for (let style = xmlElement(stylesXml, 'w:style'); style; style = xmlElement(stylesXml, 'w:style', style.end)) {
    // A style without a type is a paragraph style
    const paragraph = (xmlAttribute(style.tag, 'w:type') ?? 'paragraph') === 'paragraph';
    const ownId = xmlAttribute(style.tag, 'w:styleId');
    const found = { at: style.start, element: stylesXml.slice(style.start, style.end) };
    if (ownId === styleId && (paragraph || anyType)) return found;
    caseless ??= paragraph && ownId?.toLowerCase() === styleId.toLowerCase() ? found : undefined;
  }
  return caseless;
}
