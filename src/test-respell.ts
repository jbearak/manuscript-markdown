/**
 * Spelling a Word file's XML otherwise, as XML may spell it, and reading it
 * in one spelling, for the tests that import reads a document, and export
 * a template, the same whatever its spelling.
 */

import JSZip from 'jszip';

type Tag = { kind: 'tag'; end: boolean; empty: boolean; name: string; attributes: Array<[string, string]> };
type Token = { kind: 'text'; raw: string } | { kind: 'other'; raw: string } | Tag;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** `raw` with its entity and character references read */
function decode(raw: string): string {
  return raw.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (_match, dec: string, hex: string, name: string) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ENTITIES[name]);
}

/** The tokens of `xml`: its tags, with their attributes read, its text, and
 *  its comments, processing instructions, CDATA sections and declarations */
function tokens(xml: string): Token[] {
  const out: Token[] = [];
  let at = 0;
  while (at < xml.length) {
    if (xml[at] !== '<') {
      const next = xml.indexOf('<', at);
      const end = next === -1 ? xml.length : next;
      out.push({ kind: 'text', raw: xml.slice(at, end) });
      at = end;
      continue;
    }
    const special = ([['<!--', '-->'], ['<![CDATA[', ']]>'], ['<?', '?>'], ['<!', '>']] as const).find(([open]) => xml.startsWith(open, at));
    if (special) {
      const end = xml.indexOf(special[1], at) + special[1].length;
      out.push({ kind: 'other', raw: xml.slice(at, end) });
      at = end;
      continue;
    }
    // A tag ends at the first > outside a quoted value
    let end = at + 1;
    for (let quote = ''; end < xml.length; end++) {
      const c = xml[end];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    const raw = xml.slice(at, end + 1);
    at = end + 1;
    const tag = /^<(\/?)([^\s/>]+)([\s\S]*?)(\/?)\s*>$/.exec(raw);
    if (!tag) {
      out.push({ kind: 'other', raw });
      continue;
    }
    // Each value as an XML parser reads it: a tab or line end written as it
    // is a space, and then its references read
    const attributes: Array<[string, string]> = [];
    for (const [, name, double, single] of tag[3].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes.push([name, decode((double ?? single).replace(/\r\n?|[\t\n]/g, ' '))]);
    out.push({ kind: 'tag', end: tag[1] === '/', empty: tag[4] === '/', name: tag[2], attributes });
  }
  return out;
}

/** What looks like elements, as a comment, a CDATA section or a processing
 *  instruction holds it, which no reader takes for elements: a style named
 *  as a heading, the end of a style, its properties or the part, and
 *  properties, lists, sections, a drawing, a comment and a field */
const GHOSTS = [
  '<w:style w:type="paragraph" w:styleId="Ghost"><w:name w:val="heading 1"/><w:basedOn w:val="Ghost"/></w:style>',
  '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="99"/></w:rPr></w:style>',
  '</w:style>', '</w:rPr>', '</w:pPr>', '</w:styles>', '</w:numbering>', '</w:abstractNum>', '</w:sectPr>', '</w:body>',
  '<w:rPr><w:rFonts w:ascii="Ghost"/><w:sz w:val="99"/><w:b/><w:i/></w:rPr>', '<w:pPr><w:jc w:val="center"/><w:spacing w:after="99"/><w:ind w:left="9"/></w:pPr>',
  '<w:numId w:val="9"/>', '<w:num w:numId="1"><w:abstractNumId w:val="9"/></w:num>', '<w:numIdMacAtCleanup w:val="9"/>',
  '<w:sectPr><w:pgSz w:w="9"/></w:sectPr>', '<wp:docPr id="9" name="Ghost"/>', '<w:commentReference w:id="9"/>',
  '<w:fldSimple w:instr=" DOCPROPERTY Ghost "/>', '<w:rPrChange w:id="9"><w:rPr><w:sz w:val="99"/></w:rPr></w:rPrChange>',
];

/** One of `choices`, by `random` */
const pick = <T>(random: () => number, ...choices: T[]): T => choices[Math.floor(random() * choices.length)];

/** The attributes that hold a number, by element and attribute, as
 *  `w:numId@w:val`, which Word, import and export read by its value (see
 *  xmlInteger in xml-elements.ts and xmlHalfPoints in converter.ts), and
 *  what it is: a size in half-points, an ST_HpsMeasure, or an integer, as
 *  a list's numId and ilvl or a drawing's ID */
const NUMBERS = new Map<string, 'half-points' | 'integer'>([
  ['w:sz@w:val', 'half-points'], ['w:szCs@w:val', 'half-points'],
  ['w:numId@w:val', 'integer'], ['w:num@w:numId', 'integer'], ['w:abstractNum@w:abstractNumId', 'integer'],
  ['w:abstractNumId@w:val', 'integer'], ['w:ilvl@w:val', 'integer'], ['w:lvl@w:ilvl', 'integer'], ['wp:docPr@id', 'integer'],
]);

/** A number `value`, as `12` or `-1`, an attribute of NUMBERS holds as
 *  `kind`, spelled as its schema type allows, by `random`: with leading
 *  zeros, a plus sign, whitespace around it, or a size in points, as 7.5pt
 *  for 15 half-points (see numericValue) */
function spellNumber(value: string, kind: 'half-points' | 'integer', random: () => number): string {
  if (!/^-?\d+$/.test(value)) return value;
  const sign = value.startsWith('-') ? '-' : '';
  const digits = value.slice(sign.length);
  const n = Number(digits);
  return pick(random,
    value,
    sign + pick(random, '0', '00') + digits,
    sign ? value : '+' + digits,
    pick(random, ' ', '  ') + value + pick(random, ' ', ''),
    ...kind === 'half-points' && !sign ? [Math.floor(n / 2) + (n % 2 ? '.5' : '') + 'pt'] : [],
  );
}

/** An attribute of NUMBERS's value in one spelling, a number's plain
 *  digits, as a size in points is so many half-points, rounded down as Word
 *  rounds it (see spellNumber), and another as it is */
function numericValue(value: string, kind: 'half-points' | 'integer'): string {
  if (/^[ \t\r\n]*[+-]?\d+[ \t\r\n]*$/.test(value)) return String(Number(value.trim()) || 0);
  const points = kind === 'half-points' ? /^(\d+)(?:\.(\d+))?pt$/.exec(value) : null;
  return points ? String(Number(points[1]) * 2 + Math.floor(Number('0.' + (points[2] ?? '0')) * 2)) : value;
}

/** `value` written in an attribute in `quote`, spelled by `random`: what XML
 *  needs escaped by one reference or another, a > and the other quote as
 *  they are or escaped, and some other characters as references */
function spellValue(value: string, quote: string, random: () => number): string {
  let out = '';
  for (const c of value) {
    const code = c.codePointAt(0)!;
    const references = ['&#' + code + ';', '&#x' + code.toString(16).toUpperCase() + ';'];
    if (c === '&') out += pick(random, '&amp;', ...references);
    else if (c === '<') out += pick(random, '&lt;', ...references);
    else if (c === quote) out += pick(random, c === '"' ? '&quot;' : '&apos;', ...references);
    else if (c === '>' || c === '"' || c === "'") out += pick(random, c, c, ({ '>': '&gt;', '"': '&quot;', "'": '&apos;' } as Record<string, string>)[c], ...references);
    else if (c === '\t' || c === '\n' || c === '\r') out += pick(random, ...references);
    else out += random() < 0.1 ? pick(random, ...references) : c;
  }
  return out;
}

/**
 * `xml` spelled otherwise, as XML may spell it, by `random`, which gives
 * numbers from 0 up to 1: whitespace before each attribute, around its =
 * and before a tag's end, a line break among it; each value in either
 * quotes, with a > and the other quote in it as they are or escaped, and
 * characters as references (see spellValue), and a number as its type
 * allows (see spellNumber); and an element of a prefix
 * the root declares, as w:rPr, declaring it again, as `xmlns:w`. Its text,
 * comments and declarations are as they were.
 */
export function respellXml(xml: string, random: () => number): string {
  const all = tokens(xml);
  // The prefixes the root declares, and their namespaces
  const root = all.find((token): token is Tag => token.kind === 'tag');
  const declared = new Map((root?.attributes ?? []).filter(([name]) => name.startsWith('xmlns:')).map(([name, uri]) => [name.slice(6), uri]));
  const space = () => pick(random, ' ', ' ', ' ', '  ', '\n  ', '\t');
  // Between elements in the root, after one's end, now and then, what looks
  // like elements, in a comment, a CDATA section or a processing instruction
  let depth = 0;
  const ghost = () => {
    if (depth === 0 || random() >= 0.04) return '';
    const text = pick(random, ...GHOSTS);
    return pick(random, '<!--' + text + '-->', '<![CDATA[' + text + ']]>', '<?ghost ' + text + '?>');
  };
  return all.map(token => {
    if (token.kind !== 'tag') return token.raw;
    if (token.end) {
      depth--;
      return '</' + token.name + pick(random, '', '', ' ', '\n') + '>' + ghost();
    }
    if (!token.empty) depth++;
    const attributes = [...token.attributes];
    const prefix = token.name.includes(':') ? token.name.slice(0, token.name.indexOf(':')) : undefined;
    if (token !== root && prefix !== undefined && declared.has(prefix) && !attributes.some(([name]) => name === 'xmlns:' + prefix) && random() < 0.15) {
      attributes.push(['xmlns:' + prefix, declared.get(prefix)!]);
    }
    const written = attributes.map(([name, value]) => {
      const quote = pick(random, '"', "'");
      const number = NUMBERS.get(token.name + '@' + name);
      const spelled = number ? spellNumber(value, number, random) : value;
      return space() + name + pick(random, '', '', ' ', '\n') + '=' + pick(random, '', '', ' ') + quote + spellValue(spelled, quote, random) + quote;
    }).join('');
    return '<' + token.name + written + pick(random, '', '', ' ', '\n') + (token.empty ? '/>' + ghost() : '>');
  }).join('');
}

/**
 * `xml` in one spelling, so that two spellings of the same XML are the
 * same: each attribute after one space, in double quotes, with what XML
 * needs escaped escaped, a tab or line end as a reference, and nothing
 * else, a number in one spelling (see numericValue), and without a
 * namespace declaration an ancestor makes already; its
 * text with its references read and written again the same way; and
 * without comments, processing instructions but its declaration, or CDATA
 * sections, which respellXml puts between elements, where Word's schema
 * has no text.
 */
export function canonicalXml(xml: string): string {
  const escape = (text: string, quoted: boolean) => text.replace(quoted ? /[&<>"\t\n\r]/g : /[&<>\r]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\t': '&#x9;', '\n': '&#xA;', '\r': '&#xD;' } as Record<string, string>)[c]);
  // The namespaces in scope, innermost last
  const scopes: Array<Map<string, string>> = [];
  const bound = (prefix: string) => {
    for (let k = scopes.length - 1; k >= 0; k--) if (scopes[k].has(prefix)) return scopes[k].get(prefix);
    return undefined;
  };
  return tokens(xml).map(token => {
    if (token.kind === 'other') return /^<!--|^<!\[CDATA\[|^<\?(?!xml\s)/.test(token.raw) ? '' : token.raw;
    if (token.kind === 'text') return escape(decode(token.raw.replace(/\r\n?/g, '\n')), false);
    if (token.end) {
      scopes.pop();
      return '</' + token.name + '>';
    }
    const scope = new Map<string, string>();
    const written = token.attributes.filter(([name, value]) => {
      if (!name.startsWith('xmlns')) return true;
      const prefix = name.slice(6);
      if (bound(prefix) === value) return false;
      scope.set(prefix, value);
      return true;
    }).map(([name, value]) => {
      const number = NUMBERS.get(token.name + '@' + name);
      return ' ' + name + '="' + escape(number ? numericValue(value, number) : value, true) + '"';
    }).join('');
    if (!token.empty) scopes.push(scope);
    return '<' + token.name + written + (token.empty ? '/>' : '>');
  }).join('');
}

/**
 * A Word file with each XML part of `parts` spelled otherwise (see
 * respellXml), each by numbers of its own from `seed` and its path (see
 * partSeed), so a part's spelling depends on the seed and its own XML
 * alone, and a seed spells it the same way again whatever the other parts
 * hold, as the random IDs of a template export makes (see template in
 * respelling.property.test.ts), and whatever parts there are.
 */
export async function respellDocx(docx: Uint8Array, seed: number, parts: (path: string) => boolean = () => true): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(docx);
  for (const path of Object.keys(zip.files).sort()) {
    if (zip.files[path].dir || !/\.(xml|rels)$/.test(path) || !parts(path)) continue;
    zip.file(path, respellXml(await zip.files[path].async('string'), seeded(partSeed(seed, path))));
  }
  return zip.generateAsync({ type: 'uint8array' });
}

/** The seed of the part at `path` from `seed`: the path's 32-bit FNV-1a
 *  hash, begun from the seed */
function partSeed(seed: number, path: string): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let k = 0; k < path.length; k++) hash = Math.imul(hash ^ path.charCodeAt(k), 0x01000193) >>> 0;
  return hash;
}

/**
 * Each part of a Word file, by its path: an XML part in one spelling (see
 * canonicalXml), without what export makes anew each time, its revision
 * IDs, the document's and its lists' IDs, and its dates, and each other
 * part as it is, as base64.
 */
export async function canonicalParts(docx: Uint8Array): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(docx);
  const parts: Record<string, string> = {};
  for (const path of Object.keys(zip.files).sort()) {
    const file = zip.files[path];
    if (file.dir) continue;
    if (!/\.(xml|rels)$/.test(path)) {
      parts[path] = await file.async('base64');
      continue;
    }
    parts[path] = canonicalXml(await file.async('string'))
      .replace(/ (w:rsid\w*|w14:paraId|w14:textId|w16cid:durableId|w:tplc)="[^"]*"/g, '')
      .replace(/<w:rsid w:val="[^"]*"\/>/g, '')
      .replace(/<(w:rsidRoot|w14:docId|w15:docId|w:nsid|w:tmpl) [^>]*\/>/g, '<$1/>')
      .replace(/(<dcterms:\w+\b[^>]*>)[^<]*/g, '$1');
  }
  return parts;
}

/** Numbers from 0 up to 1, the same for the same seed */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}
