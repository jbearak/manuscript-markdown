// numbering.xml as export writes it: the lists' numbering definitions, its
// own or a template's, with the instances each list starts. Split out of
// md-to-docx.ts, whose header's invariants hold here too.
import { type XmlNode, buildOrdered, isElement, parseOrdered } from './scoped-xml';
import { maxOf } from './arrays';
import { xmlAttribute, xmlElement, xmlInteger, xmlLastMatch, xmlSearch, xmlStartTag, xmlStartTags } from './xml-elements';

function randomHex8(): string {
  return Math.floor(Math.random() * 0xFFFFFFFF).toString(16).toUpperCase().padStart(8, '0');
}

type OrderedXmlNode = XmlNode;

const childNodes = (node: OrderedXmlNode | undefined, name: string): OrderedXmlNode[] =>
  ((node?.[name] ?? []) as OrderedXmlNode[]);

const intAttr = (node: OrderedXmlNode, name: string): number => parseInt(node[':@']?.['@_' + name] ?? '', 10);

/** A template's numbering root and its w:num instances, parsed, as XML
 *  allows them to be written, with their character references read, as
 *  &#49; for 1, however many (see parseOrdered) */
function parseTemplateNumbering(xml: string): { root: OrderedXmlNode; nums: OrderedXmlNode[] } | undefined {
  const root = parseOrdered(xml)?.find(n => 'w:numbering' in n);
  return root && { root, nums: childNodes(root, 'w:numbering').filter(n => 'w:num' in n) };
}

// Whitespace, comments, CDATA sections and processing instructions, from
// where it's set to read: what goes with what's before it in markup
const NOT_MARKUP_RUN = /(?:\s|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>)*/y;

/** Where the whitespace, comments, CDATA sections and processing
 *  instructions after `at` in `xml` end */
function afterNotMarkup(xml: string, at: number): number {
  NOT_MARKUP_RUN.lastIndex = at;
  NOT_MARKUP_RUN.exec(xml);
  return NOT_MARKUP_RUN.lastIndex;
}

/** Where a template's numbering takes the instances and abstract numbering
 *  export adds, each in its markup, not a comment (see xmlSearch): before
 *  numIdMacAtCleanup, which ends the part, or else its end tag, and after
 *  its last abstract numbering and the whitespace and comments after it,
 *  or else before its first instance */
function numberingEnds(xml: string): { instancesAt?: number; abstractAt?: number } {
  const instancesAt = xmlSearch(xml, /<w:numIdMacAtCleanup\b/) ?? xmlLastMatch(xml, /<\/w:numbering\s*>/)?.index;
  const lastAbstract = xmlLastMatch(xml, /<\/w:abstractNum\s*>/);
  return { instancesAt, abstractAt: lastAbstract ? afterNotMarkup(xml, lastAbstract.index + lastAbstract.text.length) : xmlSearch(xml, /<w:num\b/) ?? instancesAt };
}

/**
 * The numIds of a template's numbering its styles use, and its headers and
 * footers, which export copies. The document can use these, and the ones its
 * bullets and numbers take (see listNumIds). The rest numbered the
 * template's own text, as a previous export's start overrides did where the
 * template is that export, and go, so that each save doesn't add more.
 */
export function templateNumIdsInUse(templateStyles?: string, headerNumIds: Iterable<number> = []): Set<number> {
  return new Set([...headerNumIds, ...styleNumIds(templateStyles)]);
}

/** The numIds a template's styles number their paragraphs with, each
 *  read as an XML parser reads it (see xmlStartTag), by its value, as
 *  import reads it (see xmlInteger), as listNumIds reads the one a
 *  numbering style gives, so that it stays in use */
export function styleNumIds(templateStyles?: string): Set<number> {
  const used = new Set<number>();
  for (const { tag } of xmlStartTags(templateStyles ?? '', ['w:numId'])) {
    const numId = xmlInteger(xmlAttribute(tag, 'w:val'));
    if (numId !== undefined) used.add(numId);
  }
  return used;
}

/** A template's numbering without each instance whose numId `drops`, and
 *  the whitespace after it, each read as an XML parser reads it (see
 *  xmlElement), its numId by its value, as import reads it (see
 *  xmlInteger). A comment, CDATA section or processing instruction after
 *  it stays, without the whitespace around it. */
function withoutNums(xml: string, drops: (numId: number) => boolean): string {
  let out = '';
  let at = 0;
  for (let num = xmlElement(xml, 'w:num'); num; num = xmlElement(xml, 'w:num', num.end)) {
    const numId = xmlInteger(xmlAttribute(num.tag, 'w:numId'));
    if (numId === undefined || !drops(numId)) continue;
    const end = afterNotMarkup(xml, num.end);
    const kept = (xml.slice(num.end, end).match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g) ?? []).join('');
    out += xml.slice(at, num.start) + kept;
    at = end;
  }
  return out + xml.slice(at);
}

/** A template's numbering without the instances the document can't use. */
export function withoutUnusedNums(xml: string, used: Set<number>): string {
  return withoutNums(xml, numId => !used.has(numId));
}

type ListKind = 'bullet' | 'decimal';

/**
 * The numIds export's bullets and numbers take in a template's numbering,
 * and those it writes its own definitions at. Each kind takes 1 or 2 where
 * the template's instance there has its format, a bullet or a number at its
 * first level, or where nothing of the template's uses it. Otherwise it
 * takes the first numId after 2 whose instance has its format and starts no
 * level over, or that nothing uses. So the template's headers, footers and
 * styles keep their numbering, and the next export, with this one as the
 * template, takes the same numIds.
 */
export function listNumIds(numberingXml: string | undefined, stylesXml: string | undefined, inUse: Set<number>): { bullet: number; decimal: number; own: Map<number, ListKind> } {
  const own = new Map<number, ListKind>();
  const numbering = numberingXml === undefined ? undefined : parseTemplateNumbering(numberingXml);
  if (!numbering) return { bullet: 1, decimal: 2, own };
  // The template's instances and abstract numberings, the first of each
  // number, and where the body of each style of the styles starts, the
  // first of each ID, each read once, so that a template of many lists, or
  // of lists that link to styles, takes time in proportion to them
  const instances = new Map<number, OrderedXmlNode>();
  const abstractNums = new Map<number, OrderedXmlNode>();
  for (const node of childNodes(numbering.root, 'w:numbering')) {
    const byNumber = 'w:num' in node ? instances : 'w:abstractNum' in node ? abstractNums : undefined;
    const number = intAttr(node, 'w:num' in node ? 'w:numId' : 'w:abstractNumId');
    if (byNumber && !Number.isNaN(number) && !byNumber.has(number)) byNumber.set(number, node);
  }
  // Each style's content, the first of each ID, read as an XML parser reads
  // it (see xmlElement), with its ID in either quotes and holding the other
  const styleBodies = new Map<string, string>();
  for (let style = xmlElement(stylesXml ?? '', 'w:style'); style; style = xmlElement(stylesXml ?? '', 'w:style', style.end)) {
    const id = xmlAttribute(style.tag, 'w:styleId');
    if (id !== undefined && !styleBodies.has(id)) styleBodies.set(id, style.content);
  }
  /** The instance a style's w:numPr gives, by the style's ID */
  const styleNumId = (styleId: string): number | undefined => {
    const numId = xmlStartTag(styleBodies.get(styleId) ?? '', 'w:numId');
    return xmlInteger(numId && xmlAttribute(numId.tag, 'w:val'));
  };
  const instance = (numId: number) => instances.get(numId);
  const formatOf = (level: OrderedXmlNode | undefined) => level && childNodes(level, 'w:lvl').find(n => 'w:numFmt' in n)?.[':@']?.['@_w:val'];
  /** An instance's format at its first level, its own or its abstract
   *  numbering's, or else the instance its abstract numbering links to
   *  through a numbering style, whose format it has */
  const ownFirstLevelFormat = (num: OrderedXmlNode): { format?: string; linked?: number } => {
    const children = childNodes(num, 'w:num');
    for (const o of children.filter(n => 'w:lvlOverride' in n && intAttr(n, 'w:ilvl') === 0)) {
      const format = formatOf(childNodes(o, 'w:lvlOverride').find(n => 'w:lvl' in n));
      if (format) return { format };
    }
    const abstractNumId = children.find(n => 'w:abstractNumId' in n);
    const abstractNum = abstractNumId && abstractNums.get(intAttr(abstractNumId, 'w:val'));
    const definition = childNodes(abstractNum, 'w:abstractNum');
    const format = formatOf(definition.find(n => 'w:lvl' in n && intAttr(n, 'w:ilvl') === 0));
    if (format) return { format };
    const link = definition.find(n => 'w:numStyleLink' in n)?.[':@']?.['@_w:val'];
    return { linked: link ? styleNumId(link) : undefined };
  };
  /** An instance's format at its first level: its own, its abstract
   *  numbering's, or that of the numbering style the abstract one links to,
   *  along the links to one that comes back around. Each instance's read
   *  once */
  const firstLevelFormats = new Map<number, string | undefined>();
  const firstLevelFormat = (numId: number): string | undefined => {
    const path = new Set<number>();
    let format: string | undefined;
    for (let id: number | undefined = numId; id !== undefined;) {
      if (firstLevelFormats.has(id)) {
        format = firstLevelFormats.get(id);
        break;
      }
      const num = instance(id);
      if (!num || path.has(id)) break;
      path.add(id);
      const own = ownFirstLevelFormat(num);
      format = own.format;
      id = own.linked;
    }
    for (const id of path) firstLevelFormats.set(id, format);
    return format;
  };
  const hasFormat = (numId: number, kind: ListKind) => {
    const format = firstLevelFormat(numId);
    return kind === 'bullet' ? format === 'bullet' : format !== undefined && format !== 'bullet' && format !== 'none';
  };
  const startsOver = (numId: number) => childNodes(instance(numId), 'w:num').some(n => 'w:lvlOverride' in n && childNodes(n, 'w:lvlOverride').some(o => 'w:startOverride' in o));
  const taken = new Set<number>();
  const pick = (preferred: number, kind: ListKind): number => {
    for (let numId = preferred; ; numId = numId === preferred ? 3 : numId + 1) {
      if (taken.has(numId)) continue;
      if (instance(numId) && hasFormat(numId, kind) && (numId === preferred || !startsOver(numId))) {
        taken.add(numId);
        return numId;
      }
      if (!inUse.has(numId)) {
        own.set(numId, kind);
        taken.add(numId);
        return numId;
      }
    }
  };
  return { bullet: pick(1, 'bullet'), decimal: pick(2, 'decimal'), own };
}

/**
 * A numbering instance that starts a level over, at `start`, at its first
 * paragraph, which is at that level. It overrides no other level: Word
 * counts the instances of one abstract numbering as one, so a sublist's
 * instance shows its parents' numbers in a label such as %1.%2 as they are,
 * and an override of a higher level would number the lists it isn't in.
 */
export type NumberingOverride = { numId: number; ilvl: number; start: number };

/**
 * The w:num of a numbering override. It keeps the level overrides of the
 * instance it copies, by level, which a template can format its lists with
 * in place of their abstract numbering, without their starts. A level
 * override left with nothing in it goes too, as Word reads one as a start
 * of 0 (tdf#153104).
 */
function numberingOverrideXml(o: NumberingOverride, abstractNumId: string,
    durableId: boolean, levelOverrides = new Map<number, string>()): string {
  const formats = new Map([...levelOverrides].map(([ilvl, inner]) =>
    [ilvl, inner.replace(/<w:startOverride\b[^>]*(?:\/>|>[\s\S]*?<\/w:startOverride>)/g, '')] as const));
  const levels = [...new Set([...formats.keys(), o.ilvl])].filter(ilvl => ilvl === o.ilvl || formats.get(ilvl)?.trim())
    .sort((a, b) => a - b);
  return '<w:num w:numId="' + o.numId + '"' + (durableId ? ' w16cid:durableId="' + Math.floor(Math.random() * 2000000000) + '"' : '') + '>' +
    '<w:abstractNumId w:val="' + abstractNumId + '"/>' +
    levels.map(ilvl => '<w:lvlOverride w:ilvl="' + ilvl + '">'
      + (ilvl === o.ilvl ? '<w:startOverride w:val="' + o.start + '"/>' : '') + (formats.get(ilvl) ?? '') + '</w:lvlOverride>').join('') +
    '</w:num>\n';
}

/** The children of the instance of a template's numbering numbered lists
 *  take, `numId`, and the abstract numbering it numbers them by */
function orderedListInstance(numbering: { nums: OrderedXmlNode[] } | undefined, numId: number): { instance: OrderedXmlNode[]; abstractNumId?: number } {
  const instance = childNodes(numbering?.nums.find(n => intAttr(n, 'w:numId') === numId), 'w:num');
  const abstractNum = instance.find(n => 'w:abstractNumId' in n);
  return { instance, abstractNumId: abstractNum && intAttr(abstractNum, 'w:val') };
}

/** How Word numbers a template's numbered lists, by level */
export type ListLevels = {
  starts: Map<number, number>; // the abstract numbering's w:start, or 0 for a level without one (ECMA-376 Part 1 §17.9.25)
  restarts: Map<number, number>; // w:lvlRestart: the level, from 1, at or above which a paragraph starts the level over, or 0 for none
  startOverrides: Map<number, number>; // the instance numbers take's, which Word applies at its first paragraph at each level
  numberedByStyles: boolean; // whether the template's styles number paragraphs in the same count, with an instance of the same abstract numbering
  bulletsCount: boolean; // whether bullets take an instance of the same abstract numbering, so their paragraphs move the count on
};

/**
 * The starts and restarts of the levels of a template's numbered lists.
 * Word ignores a start or lvlRestart in an instance's level override
 * ([MS-OI29500] 2.1.292 and 2.1.282), so they come from the abstract
 * numbering alone, and the instance numbers take, `numId`, starts a level
 * over with its start overrides, where one with nothing in it starts its
 * level at 0 (tdf#153104). Bullets, `bulletNumId` where they take the
 * template's instance, can take one of the same abstract numbering, as a
 * level override makes its first level a bullet's.
 */
export function templateListLevels(xml: string | undefined, numId: number, styleNumIds = new Set<number>(), bulletNumId?: number): ListLevels {
  const numbering = xml === undefined ? undefined : parseTemplateNumbering(xml);
  const { instance, abstractNumId } = orderedListInstance(numbering, numId);
  const numberedByStyles = abstractNumId !== undefined && (numbering?.nums ?? []).some(num => styleNumIds.has(intAttr(num, 'w:numId'))
    && childNodes(num, 'w:num').some(n => 'w:abstractNumId' in n && intAttr(n, 'w:val') === abstractNumId));
  const bulletsCount = abstractNumId !== undefined && bulletNumId !== undefined && orderedListInstance(numbering, bulletNumId).abstractNumId === abstractNumId;
  const levels: ListLevels = { starts: new Map(), restarts: new Map(), startOverrides: new Map(), numberedByStyles, bulletsCount };
  const abstractNum = childNodes(numbering?.root, 'w:numbering')
    .find(n => 'w:abstractNum' in n && intAttr(n, 'w:abstractNumId') === abstractNumId);
  // The w:val of the `name` in each `element` of `nodes`, by level, or
  // `otherwise` where it has none. A start or start override can be below
  // 0, which no Markdown list starts at, so the list gets its own start.
  const values = (nodes: OrderedXmlNode[], element: string, name: string, into: Map<number, number>, otherwise?: number, least = -Infinity) => {
    for (const node of nodes.filter(n => element in n)) {
      const child = childNodes(node, element).find(n => name in n);
      const ilvl = intAttr(node, 'w:ilvl'), value = child ? intAttr(child, 'w:val') : otherwise ?? NaN;
      if (Number.isInteger(ilvl) && Number.isInteger(value) && value >= least) into.set(ilvl, value);
    }
  };
  values(childNodes(abstractNum, 'w:abstractNum'), 'w:lvl', 'w:start', levels.starts, 0);
  values(childNodes(abstractNum, 'w:abstractNum'), 'w:lvl', 'w:lvlRestart', levels.restarts, undefined, 0);
  values(instance, 'w:lvlOverride', 'w:startOverride', levels.startOverrides);
  for (const node of instance.filter(n => 'w:lvlOverride' in n)) {
    const ilvl = intAttr(node, 'w:ilvl');
    // One with no element, whatever else it holds, as a processing
    // instruction, which Word reads as one with nothing in it
    if (Number.isInteger(ilvl) && !childNodes(node, 'w:lvlOverride').some(isElement)) levels.startOverrides.set(ilvl, 0);
  }
  return levels;
}

/** A template's numbering with start overrides added as instances like the
 *  one numbers take, `numId`, or undefined when it has none. */
export function withNumberingOverrides(xml: string, startOverrides: NumberingOverride[], numId: number): string | undefined {
  const numbering = parseTemplateNumbering(xml);
  const { instance, abstractNumId } = orderedListInstance(numbering, numId);
  // w:num entries go before numIdMacAtCleanup, which ends the part
  const at = numberingEnds(xml).instancesAt;
  if (!numbering || abstractNumId === undefined || !Number.isInteger(abstractNumId) || at === undefined) return undefined;
  // Each level override's elements, without a processing instruction or
  // text, as a CDATA section's, which Word's schema has no place for there
  // and which would keep an override that holds nothing else once its start
  // goes (see numberingOverrideXml)
  const levelOverrides = new Map<number, string>();
  for (const n of instance) {
    const ilvl = intAttr(n, 'w:ilvl');
    if ('w:lvlOverride' in n && Number.isInteger(ilvl)) levelOverrides.set(ilvl, buildOrdered(childNodes(n, 'w:lvlOverride').filter(isElement)));
  }
  // Durable IDs only where the template declares their namespace
  const durableId = numbering.root[':@']?.['@_xmlns:w16cid'] !== undefined;
  return xml.slice(0, at) + startOverrides.map(o => numberingOverrideXml(o, String(abstractNumId), durableId, levelOverrides)).join('') + xml.slice(at);
}

/** Level definitions with the random identifiers Word expects on them.
 *  Without these, Word adds them on open, marking the document as modified. */
function lvlsWithTplc(lvls: string[]): string {
  return lvls.map((lvl, i) => {
    const tplc = randomHex8();
    return lvl.replace('<w:lvl w:ilvl="' + i + '">', '<w:lvl w:ilvl="' + i + '" w:tplc="' + tplc + '">');
  }).join('\n');
}

/** Export's abstract numbering for bullets or numbers, at `abstractNumId`.
 *  `w15` says whether the part declares the namespace of its attribute. */
function defaultAbstractNumXml(kind: 'bullet' | 'decimal', abstractNumId: number, w15 = true): string {
  const lvls = Array.from({length: 9}, (_, i) => {
    const indent = (i + 1) * 720;
    const format = kind === 'bullet' ? '<w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>' : '<w:numFmt w:val="decimal"/><w:lvlText w:val="%' + (i + 1) + '."/>';
    return '<w:lvl w:ilvl="' + i + '"><w:start w:val="1"/>' + format + '<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="' + indent + '" w:hanging="360"/></w:pPr></w:lvl>';
  });
  return '<w:abstractNum w:abstractNumId="' + abstractNumId + '"' + (w15 ? ' w15:restartNumberingAfterBreak="0"' : '') + '>\n' +
    '<w:nsid w:val="' + randomHex8() + '"/>\n' +
    '<w:multiLevelType w:val="hybridMultilevel"/>\n' +
    '<w:tmpl w:val="' + randomHex8() + '"/>\n' +
    lvlsWithTplc(lvls) + '\n' +
    '</w:abstractNum>\n';
}

/**
 * A template's numbering with export's own bullets and numbers at the
 * numIds listNumIds gives them, in place of any instance of the template's
 * there, so that its other definitions, which its headers and styles can
 * use, stay
 */
export function withOwnNums(xml: string, own: Map<number, ListKind>): string {
  if (own.size === 0) return xml;
  xml = withoutNums(xml, numId => own.has(numId));
  const numbering = parseTemplateNumbering(xml);
  if (!numbering) return xml;
  const abstractNumIds = childNodes(numbering.root, 'w:numbering').filter(n => 'w:abstractNum' in n).map(n => intAttr(n, 'w:abstractNumId'));
  let next = maxOf(abstractNumIds.filter(Number.isInteger), -1) + 1;
  const declares = (prefix: string) => numbering.root[':@']?.['@_xmlns:' + prefix] !== undefined;
  let abstractNums = '', nums = '';
  for (const [numId, kind] of own) {
    abstractNums += defaultAbstractNumXml(kind, next, declares('w15'));
    nums += '<w:num w:numId="' + numId + '"' + (declares('w16cid') ? ' w16cid:durableId="' + Math.floor(Math.random() * 2000000000) + '"' : '') +
      '><w:abstractNumId w:val="' + next + '"/></w:num>\n';
    next++;
  }
  // Abstract numbering goes before the instances, which go before
  // numIdMacAtCleanup, which ends the part
  const { instancesAt: end, abstractAt } = numberingEnds(xml);
  if (end === undefined || abstractAt === undefined) return xml;
  return xml.slice(0, abstractAt) + abstractNums + xml.slice(abstractAt, end) + nums + xml.slice(end);
}

export function numberingXml(startOverrides?: NumberingOverride[]): string {
  const durableId1 = Math.floor(Math.random() * 2000000000);
  const durableId2 = Math.floor(Math.random() * 2000000000);

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w15 w16cid">\n' +
    defaultAbstractNumXml('bullet', 0) +
    defaultAbstractNumXml('decimal', 1) +
    '<w:num w:numId="1" w16cid:durableId="' + durableId1 + '"><w:abstractNumId w:val="0"/></w:num>\n' +
    '<w:num w:numId="2" w16cid:durableId="' + durableId2 + '"><w:abstractNumId w:val="1"/></w:num>\n' +
    // Emit extra w:num entries for ordered lists with their own start
    (startOverrides ?? []).map(o => numberingOverrideXml(o, '1', true)).join('') +
    '</w:numbering>';
}
