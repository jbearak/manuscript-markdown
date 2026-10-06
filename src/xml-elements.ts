// Reading an element of WordprocessingML's XML as an XML parser does: its
// start tag with whitespace around an attribute's = and its value in either
// quotes, which may hold a >, and its attributes' character references. For
// import, which reads a document's styles and runs with them, and for the
// style lookup import and export share (see style-element.ts).

// An XML start tag's attributes after its name, as an XML parser reads
// them: each after whitespace, with any whitespace around its =, and its
// value in double or single quotes, which may hold a >
const XML_TAG_ATTRIBUTES = '(?:\\s+[^\\s=/>]+\\s*=\\s*(?:"[^"]*"|\'[^\']*\'))*\\s*';

/** The start tag of the first element `name` in `xml` from `from`, as
 *  `<w:sz w:val="22"/>`, with its attributes as XML may spell them (see
 *  XML_TAG_ATTRIBUTES), where it starts and ends, and whether it's empty,
 *  as `<w:rPr/>`. By its name with the w prefix, as import's other
 *  readers take WordprocessingML's (see readZipXml in converter.ts).
 *  Undefined for none. */
export function xmlStartTag(xml: string, name: string, from = 0): { tag: string; start: number; end: number; empty: boolean } | undefined {
  const start = new RegExp('<' + name + XML_TAG_ATTRIBUTES + '(/?)>', 'g');
  start.lastIndex = from;
  const match = start.exec(xml);
  return match ? { tag: match[0], start: match.index, end: match.index + match[0].length, empty: match[1] === '/' } : undefined;
}

/** The first element `name` in `xml` from `from` (see xmlStartTag), with
 *  its content, '' where it's empty, up to the first end tag of its name,
 *  as the elements read so don't hold their own, and where it ends.
 *  Undefined for none, or one with no end. */
export function xmlElement(xml: string, name: string, from = 0): { tag: string; content: string; start: number; end: number } | undefined {
  const start = xmlStartTag(xml, name, from);
  if (!start) return undefined;
  if (start.empty) return { tag: start.tag, content: '', start: start.start, end: start.end };
  const close = new RegExp('</' + name + '\\s*>', 'g');
  close.lastIndex = start.end;
  const end = close.exec(xml);
  return end ? { tag: start.tag, content: xml.slice(start.end, end.index), start: start.start, end: end.index + end[0].length } : undefined;
}

/** An attribute of a start tag (see xmlStartTag), by its name, as `w:val`,
 *  with its character references decoded, as export escapes a name such as
 *  "A & B", or undefined where it hasn't it */
export function xmlAttribute(tag: string, name: string): string | undefined {
  for (const [, attribute, double, single] of tag.matchAll(/\s([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (attribute !== name) continue;
    return (double ?? single).replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (_, dec: string, hex: string, entity: string) =>
      dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16))
        : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity]);
  }
  return undefined;
}
