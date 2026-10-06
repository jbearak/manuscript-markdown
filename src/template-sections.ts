// A template's headers and footers, which export copies into the document.
//
// A template's sectPr names its headers and footers, and its printer
// settings, by relationship ID. Export reuses the template's trailing sectPr,
// so it copies each part a reference names, with the parts that part names
// in turn (a header's images), their own relationships and their content
// types. Those relationships are document.xml's first, rId1 to rIdN, before
// export's own, so their IDs stay sequential (dirty-flag invariant #6) and
// the rId remap after generation, which only moves IDs above the reserved
// ones, leaves them.
//
// Invariants:
// - The export's first section carries the references and the title page
//   setting. A section without a reference of a type takes the previous
//   section's, so the sections export adds for orientation continue the
//   headers and footers, and only the document's first page is a title
//   page. The template's trailing sectPr goes without them.
// - The references are the ones the template's last section shows, each
//   type its own or the last earlier section's. The title page setting is
//   the template's first section's, whose first page is the document's. So
//   a previous export, whose first section holds the references, gives back
//   the same ones.
// - A reference goes if the template lacks its relationship or part, or
//   its relationship is of another type. Kept, it would name nothing, or a
//   part export writes for something else.

import type JSZip from 'jszip';

/** A part the template's sections name, as the template holds it */
interface TemplatePart {
  data: Uint8Array;
  contentType?: string;
  /** Whether the template types it by its extension */
  byExtension: boolean;
  /** Its relationships part, as the template holds it */
  rels?: string;
}

export interface TemplateRelationship {
  type: string;
  /** The template's path for the part, or the URL of an external target */
  target: string;
  external: boolean;
}

export interface TemplateSections {
  /** The template's trailing sectPr without its header and footer references
   *  or title page setting, its other relationship IDs renumbered */
  sectPr?: string;
  /** The references the export's first section takes, with IDs from rId1 */
  references: string;
  titlePg: boolean;
  /** The template's settings show different headers on even pages */
  evenAndOddHeaders: boolean;
  /** document.xml's relationships rId1 to rIdN */
  relationships: TemplateRelationship[];
  parts: Map<string, TemplatePart>;
}

const HEADER_FOOTER_REFERENCE = /<w:(header|footer)Reference\b[^>]*?\/>/g;
const TITLE_PG = /<w:titlePg\b[^>]*?\/>/g;
/** sectPr's children after titlePg, which titlePg goes before */
const AFTER_TITLE_PG = /<w:(?:textDirection|bidi|rtlGutter|docGrid|printerSettings|sectPrChange)\b/;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** An attribute's value, its references to characters resolved */
const attr = (tag: string, name: string) => new RegExp('\\s' + name + '="([^"]*)"').exec(tag)?.[1]
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => ENTITIES[entity]);
const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isOn = (tag: string) => !/\sw:val="(?:0|false|off)"/.test(tag);

/** The path of a part's relationships part */
const relsPathOf = (part: string) => {
  const slash = part.lastIndexOf('/');
  return part.slice(0, slash + 1) + '_rels/' + part.slice(slash + 1) + '.rels';
};

/** A relationship's target as a path in the package, from its source part */
function resolveTarget(source: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const segments = source.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '.' && segment !== '') segments.push(segment);
  }
  return segments.join('/');
}

/** The target that names a part from a source part */
function relativeTarget(source: string, part: string): string {
  const from = source.split('/').slice(0, -1);
  const to = part.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return '../'.repeat(from.length - common) + to.slice(common).join('/');
}

/** A part's relationships, by ID */
function relationshipsOf(source: string, relsXml: string | undefined): Map<string, TemplateRelationship> {
  const relationships = new Map<string, TemplateRelationship>();
  for (const [tag] of (relsXml ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(tag, 'Id'), type = attr(tag, 'Type'), target = attr(tag, 'Target');
    if (!id || !type || target === undefined) continue;
    const external = attr(tag, 'TargetMode') === 'External';
    relationships.set(id, { type, target: external ? target : resolveTarget(source, target), external });
  }
  return relationships;
}

/** The sectPrs that are a section's own, in order: a paragraph's and the
 *  body's, but not the one a tracked change to one holds */
function sectPrsOf(documentXml: string): string[] {
  const sectPrs: string[] = [];
  let depth = 0, start = 0;
  for (const m of documentXml.matchAll(/<w:sectPr(?=[\s>/])[^>]*?(\/?)>|<\/w:sectPr>/g)) {
    if (m[0].startsWith('</')) {
      if (depth > 0 && --depth === 0) sectPrs.push(documentXml.slice(start, m.index! + m[0].length));
    } else if (m[1]) {
      if (depth === 0) sectPrs.push(m[0]);
    } else if (depth++ === 0) {
      start = m.index!;
    }
  }
  return sectPrs;
}

/** A sectPr's own properties, before any tracked change to them, and the change */
function splitSectPr(sectPr: string): [string, string] {
  const change = sectPr.indexOf('<w:sectPrChange');
  if (change < 0) return [sectPr, ''];
  return [sectPr.slice(0, change), sectPr.slice(change)];
}

/** A template's headers and footers, the parts they name, and its trailing sectPr */
export async function readTemplateSections(zip: JSZip): Promise<TemplateSections> {
  const result: TemplateSections = { references: '', titlePg: false, evenAndOddHeaders: false, relationships: [], parts: new Map() };
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) return result;
  const bodyClose = documentXml.lastIndexOf('</w:body>');
  const sectPrs = sectPrsOf(bodyClose < 0 ? documentXml : documentXml.slice(0, bodyClose));
  if (sectPrs.length === 0) return result;

  const contentTypesXml = await zip.file('[Content_Types].xml')?.async('string') ?? '';
  const overrides = new Map<string, string>(), defaults = new Map<string, string>();
  for (const [tag] of contentTypesXml.matchAll(/<Override\b[^>]*>/g)) {
    const name = attr(tag, 'PartName'), type = attr(tag, 'ContentType');
    if (name && type) overrides.set(name.replace(/^\//, ''), type);
  }
  for (const [tag] of contentTypesXml.matchAll(/<Default\b[^>]*>/g)) {
    const ext = attr(tag, 'Extension'), type = attr(tag, 'ContentType');
    if (ext && type) defaults.set(ext.toLowerCase(), type);
  }
  const documentRels = relationshipsOf('word/document.xml', await zip.file('word/_rels/document.xml.rels')?.async('string'));

  /** Take a part, and the parts it names, for copying */
  const take = async (path: string): Promise<void> => {
    if (result.parts.has(path)) return;
    const file = zip.file(path);
    if (!file) return;
    const override = overrides.get(path);
    const part: TemplatePart = {
      data: await file.async('uint8array'),
      contentType: override ?? defaults.get(path.slice(path.lastIndexOf('.') + 1).toLowerCase()),
      byExtension: override === undefined,
    };
    result.parts.set(path, part);
    part.rels = await zip.file(relsPathOf(path))?.async('string');
    for (const relationship of relationshipsOf(path, part.rels).values()) {
      if (!relationship.external) await take(relationship.target);
    }
  };
  /** A template relationship's ID among document.xml's, or none if it names
   *  nothing, or something other than a part of `type` */
  const ids = new Map<string, string>();
  const idFor = async (templateId: string, type?: string): Promise<string | undefined> => {
    const relationship = documentRels.get(templateId);
    if (!relationship || !relationship.external && !zip.file(relationship.target)) return undefined;
    if (type && !relationship.type.endsWith('/' + type)) return undefined;
    if (ids.has(templateId)) return ids.get(templateId);
    if (!relationship.external) await take(relationship.target);
    result.relationships.push(relationship);
    const id = 'rId' + result.relationships.length;
    ids.set(templateId, id);
    return id;
  };

  // Each type of reference as the last section shows it
  const references = new Map<string, [string, string]>();
  for (const sectPr of sectPrs) {
    for (const [tag, kind] of splitSectPr(sectPr)[0].matchAll(HEADER_FOOTER_REFERENCE)) {
      references.set(kind + ':' + (attr(tag, 'w:type') ?? 'default'), [tag, kind]);
    }
  }
  for (const [tag, kind] of references.values()) {
    const id = await idFor(attr(tag, 'r:id') ?? '', kind);
    if (id) result.references += tag.replace(/(\sr:id=")[^"]*"/, (_, before: string) => before + id + '"');
  }
  result.titlePg = [...splitSectPr(sectPrs[0])[0].matchAll(TITLE_PG)].some(([tag]) => isOn(tag));

  // The trailing sectPr, whose other relationships, as its printer
  // settings', get their IDs, or go with what names them
  const [own, change] = splitSectPr(sectPrs[sectPrs.length - 1]);
  let rest = own.replace(HEADER_FOOTER_REFERENCE, '').replace(TITLE_PG, '');
  for (const [tag] of [...rest.matchAll(/<w:\w+\b[^>]*?\sr:id="[^"]*"[^>]*?\/>/g)]) {
    const id = await idFor(attr(tag, 'r:id')!);
    rest = rest.replace(tag, () => id ? tag.replace(/(\sr:id=")[^"]*"/, (_, before: string) => before + id + '"') : '');
  }
  result.sectPr = rest + change;

  const settings = await zip.file('word/settings.xml')?.async('string');
  const evenAndOdd = settings?.match(/<w:evenAndOddHeaders\b[^>]*?\/>/);
  result.evenAndOddHeaders = !!evenAndOdd && isOn(evenAndOdd[0]);
  return result;
}

/** A sectPr with the template's header and footer references and title page setting */
export function withSectionHeaders(sectPr: string, references: string, titlePg: boolean): string {
  if (!references && !titlePg) return sectPr;
  const open = /^<w:sectPr\b[^>]*?(\/?)>/.exec(sectPr);
  if (!open) return sectPr;
  let xml = open[1] ? open[0].slice(0, -2) + '>' + '</w:sectPr>' : sectPr;
  const openEnd = open[1] ? open[0].length - 1 : open[0].length;
  xml = xml.slice(0, openEnd) + references + xml.slice(openEnd);
  if (titlePg) {
    const [own, change] = splitSectPr(xml);
    const after = AFTER_TITLE_PG.exec(own);
    const at = after ? after.index : change ? own.length : own.lastIndexOf('</w:sectPr>');
    xml = own.slice(0, at) + '<w:titlePg/>' + own.slice(at) + change;
  }
  return xml;
}

/** Whether a part holds UTF-8, which export can change, or UTF-16, which goes as it came */
const isUtf8 = (bytes: Uint8Array) => !(bytes[0] === 0 || bytes[1] === 0 || bytes[0] === 0xFF && bytes[1] === 0xFE || bytes[0] === 0xFE && bytes[1] === 0xFF);

/**
 * Copy the parts a template's sections name into the export, each at its
 * template path or, where export has a part there, as its images, the next
 * free name like it. A drawing's ID, which the document's drawings share,
 * continues from `nextDocPrId`. Returns document.xml's relationships, with
 * targets from it, and the content types the parts need, the extensions'
 * where the export types none of them otherwise.
 */
export function addTemplateSectionParts(
  zip: JSZip,
  sections: TemplateSections,
  nextDocPrId: number,
  extensionTypes: Map<string, string>,
): { relationships: Array<{ type: string; target: string; external: boolean }>; defaults: Map<string, string>; overrides: Map<string, string> } {
  const paths = new Map<string, string>();
  const taken = (path: string) => zip.file(path) !== null || [...paths.values()].includes(path);
  for (const path of sections.parts.keys()) {
    let free = path;
    const m = /^(.*?)(\d*)(\.[^./]*)?$/.exec(path)!;
    for (let n = m[2] ? parseInt(m[2], 10) : 1; taken(free); n++) free = m[1] + n + (m[3] ?? '');
    paths.set(path, free);
  }
  const defaults = new Map<string, string>(), overrides = new Map<string, string>();
  for (const [path, part] of sections.parts) {
    const target = paths.get(path)!;
    let data: Uint8Array | string = part.data;
    if (/\.xml$/i.test(path) && isUtf8(part.data)) {
      data = new TextDecoder().decode(part.data).replace(/(<wp:docPr\b[^>]*?\sid=")\d+"/g, (_, before: string) => before + (nextDocPrId++) + '"');
    }
    zip.file(target, data);
    if (part.rels !== undefined) {
      zip.file(relsPathOf(target), part.rels.replace(/<Relationship\b[^>]*>/g, tag => {
        const to = attr(tag, 'Target');
        if (to === undefined || attr(tag, 'TargetMode') === 'External') return tag;
        const moved = paths.get(resolveTarget(path, to));
        return moved && moved !== resolveTarget(path, to)
          ? tag.replace(/(\sTarget=")[^"]*"/, (_, before: string) => before + escapeAttr(relativeTarget(target, moved)) + '"')
          : tag;
      }));
    }
    if (!part.contentType) continue;
    const ext = target.slice(target.lastIndexOf('.') + 1).toLowerCase();
    const known = extensionTypes.get(ext) ?? defaults.get(ext);
    if (part.byExtension && (known === undefined || known === part.contentType)) {
      if (known === undefined) defaults.set(ext, part.contentType);
    } else {
      overrides.set(target, part.contentType);
    }
  }
  const relationships = sections.relationships.map(r => r.external ? r : { ...r, target: relativeTarget('word/document.xml', paths.get(r.target) ?? r.target) });
  return { relationships, defaults, overrides };
}
