// Finding a style in styles.xml as Word does, for import, which reads a
// document's styles, and for export, which reads and changes a template's.
// Both find a style by the same reader, so that what export makes of a
// template's style is what import reads back from it.

/** Where the next w:style element starts in `stylesXml` from `from`, or -1,
 *  with any whitespace before its first attribute */
function nextStyleStart(stylesXml: string, from: number): number {
  const start = /<w:style\s/g;
  start.lastIndex = from;
  return start.exec(stylesXml)?.index ?? -1;
}

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
 * type. A style written as <w:style .../> is its tag alone, and the next
 * </w:style> closes another.
 */
export function findStyleElement(stylesXml: string, id: string, ids: Map<string, string>, anyType = false): { at: number; element: string } | undefined {
  const styleId = ids.get(id) ?? id;
  let caseless: { at: number; element: string } | undefined;
  let searchFrom = 0;
  while (true) {
    const at = nextStyleStart(stylesXml, searchFrom);
    if (at === -1) return caseless;
    const tagEnd = stylesXml.indexOf('>', at) + 1;
    if (tagEnd === 0) return caseless;
    const empty = stylesXml[tagEnd - 2] === '/';
    const closeTag = empty ? tagEnd : stylesXml.indexOf('</w:style>', tagEnd);
    if (closeTag === -1) return caseless;
    const element = stylesXml.substring(at, empty ? tagEnd : closeTag + '</w:style>'.length);
    const tag = element.slice(0, tagEnd - at);
    // A style without a type is a paragraph style
    const paragraph = (/\sw:type\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? 'paragraph') === 'paragraph';
    if (element.includes('w:styleId="' + styleId + '"') && (paragraph || anyType)) return { at, element };
    caseless ??= paragraph && /\sw:styleId\s*=\s*"([^"]*)"/.exec(tag)?.[1].toLowerCase() === styleId.toLowerCase() ? { at, element } : undefined;
    searchFrom = at + element.length;
  }
}
