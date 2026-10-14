// Reading an element of WordprocessingML's XML as an XML parser does: its
// start tag with whitespace around an attribute's = and its value in either
// quotes, which may hold a >, and its attributes' character references. For
// import, which reads a document's styles and runs with them, and for the
// style lookup import and export share (see style-element.ts). And reading
// an on/off value, as WordprocessingML's and an equation's OMML spell it,
// and a number, an integer and a length in twips, as XML Schema and
// WordprocessingML spell them, for import's readers and export's of a
// template's sections alike.

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
 *  and not false, 0 or off, with XML's white space around it, as
 *  xsd:boolean's are read. Every on or off value import reads, an
 *  element's w:val (see isToggleOn in converter.ts) or m:val (see ommlOn
 *  in omml.ts), or an attribute's, goes through this, and so do those
 *  export reads of a template's columns (see fitColumns in md-to-docx.ts
 *  and layoutKey in template-sections.ts). */
export function xmlOn(value: string | undefined): boolean {
  const said = value?.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');
  return said === 'true' || said === '1' || said === 'on';
}

/** A whole number an attribute holds, as an xsd:unsignedLong's: digits,
 *  with leading zeros, a plus sign before them and whitespace around them,
 *  as a schema's number may have */
export function xmlNumber(value: string | undefined): number | undefined {
  return value !== undefined && /^[ \t\r\n]*\+?\d+[ \t\r\n]*$/.test(value) ? Number(value) : undefined;
}

// A universal measure (ST_UniversalMeasure): a decimal number and its unit,
// as 8.5in, with digits before any point, a minus sign where it may have
// one, and no whitespace around it, as it's a string's pattern
const UNIVERSAL_MEASURE = /^(-?)(\d+)(?:\.(\d+))?(mm|cm|in|pt|pc|pi)$/;

// Twips in each unit of a universal measure, as a fraction: a pica, pc or
// pi, is 12 points, an inch 72, and a centimeter 1/2.54 of an inch
const TWIPS_PER_UNIT: Record<string, readonly [bigint, bigint]> = {
  in: [1440n, 1n], pt: [20n, 1n], pc: [240n, 1n], pi: [240n, 1n], cm: [144000n, 254n], mm: [14400n, 254n],
};

/**
 * A universal measure's size in `perUnit`'s units, as twips, from a unit
 * `perUnit` has, or undefined from another, or with a minus sign where it's
 * not `signed`, as an ST_PositiveUniversalMeasure has none. Word rounds a
 * size in centimeters or millimeters to the nearest twip, and in the other
 * units down, as 0.99pt to 19 twips, so this does too, by its digits'
 * value, not a float's, so 0.3in is 432 twips, not 431. A negative one is
 * the negative of the one without its minus sign, as the schema means it.
 */
export function universalMeasure(value: string, signed: boolean, perUnit: Record<string, readonly [bigint, bigint]>): number | undefined {
  const match = UNIVERSAL_MEASURE.exec(value);
  const ratio = match ? perUnit[match[4]] : undefined;
  if (!match || !ratio || match[1] && !signed) return undefined;
  const fraction = match[3] ?? '';
  const numerator = BigInt(match[2] + fraction) * ratio[0];
  const denominator = 10n ** BigInt(fraction.length) * ratio[1];
  const nearest = match[4] === 'cm' || match[4] === 'mm';
  const size = Number(nearest ? (2n * numerator + denominator) / (2n * denominator) : numerator / denominator);
  return match[1] && size ? -size : size;
}

/** A length in twips an attribute holds, as an ST_TwipsMeasure's: a whole
 *  number of twips (see xmlNumber), as 360, or a universal measure, as 18pt
 *  or 0.25in, the twips it is (see universalMeasure), or, `signed`, as an
 *  ST_SignedTwipsMeasure's, either with a minus sign (see xmlInteger). Every
 *  reader of a page's size, an indent or a paragraph's spacing goes through
 *  this, export's of a template's page, margins and columns too, so a
 *  length reads as one in any unit, as Word reads it. */
export function xmlTwips(value: string | undefined, signed = false): number | undefined {
  if (value === undefined) return undefined;
  return (signed ? xmlInteger(value) : xmlNumber(value)) ?? universalMeasure(value, signed, TWIPS_PER_UNIT);
}

// An integer as an xsd:integer is written (see xmlInteger)
const XML_INTEGER = /^[ \t\r\n]*[+-]?\d+[ \t\r\n]*$/;

/** An integer an attribute holds, as an xsd:integer's or an
 *  ST_DecimalNumber's: digits, with leading zeros, a sign before them and
 *  whitespace around them (see xmlNumber). Import reads an integer with
 *  this (see xmlTwips, and xmlNumberId in converter.ts), and export a
 *  template's list's numId and its notes' start (see noteNumberingOf in
 *  md-to-docx.ts), so they agree. */
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
