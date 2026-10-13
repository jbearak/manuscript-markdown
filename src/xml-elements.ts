// Reading an element of WordprocessingML's XML as an XML parser does: its
// start tag with whitespace around an attribute's = and its value in either
// quotes, which may hold a >, and its attributes' character references. For
// import, which reads a document's styles and runs with them, and for the
// style lookup import and export share (see style-element.ts). And reading
// an on/off value, as WordprocessingML's and an equation's OMML spell it,
// and an integer, as XML Schema spells one.

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

/** Each start tag of an element of `names` in `xml`, in order, as
 *  xmlStartTag reads it, with its name */
export function xmlStartTags(xml: string, names: string[]): Array<{ name: string; tag: string; start: number; end: number; empty: boolean }> {
  const start = new RegExp('<(' + names.join('|') + ')' + XML_TAG_ATTRIBUTES + '(/?)>', 'g');
  return [...xml.matchAll(start)].map(match => ({ name: match[1], tag: match[0], start: match.index, end: match.index + match[0].length, empty: match[2] === '/' }));
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

/** Whether an attribute's value is on, as an ST_OnOff's: true, 1 or on,
 *  and not false, 0 or off. Every on or off value import reads, an
 *  element's w:val (see isToggleOn in converter.ts) or m:val (see ommlOn
 *  in omml.ts), or an attribute's, goes through this. */
export function xmlOn(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'on';
}

// An integer as an xsd:integer is written (see xmlInteger)
const XML_INTEGER = /^[ \t\r\n]*[+-]?\d+[ \t\r\n]*$/;

/** An integer an attribute holds, as an xsd:integer's or an
 *  ST_DecimalNumber's: digits, with leading zeros, a sign before them and
 *  whitespace around them (see xmlNumber in converter.ts). Import reads
 *  an integer with this (see xmlTwips and xmlNumberId in converter.ts),
 *  and export a template's list's numId, so they agree. */
export function xmlInteger(value: string | undefined): number | undefined {
  return value !== undefined && XML_INTEGER.test(value) ? Number(value) : undefined;
}

/** `xml` with each element of `names` (see xmlElement) as `replace` gives
 *  it, from its XML and its name, as a tracked change's record (w:rPrChange,
 *  w:pPrChange) set aside or left out. Each is read from where the one
 *  before ends, so one inside another goes with it, and one with no end
 *  stays as it is. */
export function replaceXmlElements(xml: string, names: string[], replace: (element: string, name: string) => string): string {
  const starts = new RegExp('<(' + names.join('|') + ')(?=[\\s/>])', 'g');
  let out = '';
  let at = 0;
  for (let found = starts.exec(xml); found; found = starts.exec(xml)) {
    const element = xmlElement(xml, found[1], found.index);
    if (element === undefined || element.start !== found.index) continue;
    out += xml.slice(at, element.start) + replace(xml.slice(element.start, element.end), found[1]);
    at = element.end;
    starts.lastIndex = element.end;
  }
  return out + xml.slice(at);
}
