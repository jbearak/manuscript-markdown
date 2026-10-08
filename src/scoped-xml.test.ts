import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import JSZip from 'jszip';
import { compatibilityProblems, documentCompatibilityProblems } from './markup-compatibility-check';
import { convertMdToDocx } from './md-to-docx';
import { xmlParser } from './xml-parser';
import { COMPATIBILITY_LISTS, EXPORT_CONTEXT, EXPORT_NAMESPACES, MARKUP_COMPATIBILITY, NO_COMPATIBILITY, ORDERED_OPTIONS, WORDPROCESSINGML, WORD_UNDERSTOOD_NAMESPACES, XMLNS_NAMESPACE, XML_NAMESPACE, attributeNamed, attributesOf, buildOrdered, canonical, childrenOf, chosenBranch, compatibilityIn, contextIn, effectiveSectPr, elementsIn, expandName, isElement, isIgnored, isNamed, isProcessedWrapper, mapProperties, moved, nameOf, parseOrdered, resolvedNode, scopeIn, sectPrPropertyOf, sectPrRank, withProperties, type Context, type Scope, type XmlNode } from './scoped-xml';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const NONE: Scope = new Map();
/** A document's element, parsed, with the scope it's in */
const root = (xml: string) => {
  const node = parseOrdered(xml)!.find(node => !nameOf(node).startsWith('?'))!;
  return { node, scope: NONE };
};

describe('XML read by namespace', () => {
  it('names an element by the namespace its prefix is bound to where it is, its own declarations too', () => {
    const { node, scope } = root('<a:x xmlns:a="urn:a"><a:y xmlns:a="urn:b"/><z/></a:x>');
    expect(isNamed(node, scope, 'urn:a', 'x')).toBe(true);
    const [y, z] = elementsIn(node, scope);
    // Its own declaration rebinds its prefix
    expect(isNamed(y.node, y.scope, 'urn:b', 'y')).toBe(true);
    expect(isNamed(y.node, y.scope, 'urn:a', 'y')).toBe(false);
    // No prefix and no default namespace is no namespace
    expect(expandName(nameOf(z.node), z.scope)).toEqual({ namespace: undefined, local: 'z' });
  });

  it('puts an element without a prefix in the default namespace, and an attribute without one in none', () => {
    const { node, scope } = root('<x xmlns="urn:d" xmlns:p="urn:p" a="1" p:a="2"/>');
    expect(isNamed(node, scope, 'urn:d', 'x')).toBe(true);
    expect(attributeNamed(node, scope, undefined, 'a')).toBe('1');
    expect(attributeNamed(node, scope, 'urn:p', 'a')).toBe('2');
    expect(attributeNamed(node, scope, 'urn:d', 'a')).toBeUndefined();
  });

  it('lists an element\'s attributes by namespace, but its declarations, and leaves no default namespace where xmlns="" undeclares it', () => {
    const { node, scope } = root('<x xmlns="urn:d" xmlns:p="urn:p" a="1" p:a="2"><y xmlns=""/></x>');
    expect(attributesOf(node, scope)).toEqual([
      { key: '@_a', namespace: undefined, local: 'a', value: '1' },
      { key: '@_p:a', namespace: 'urn:p', local: 'a', value: '2' },
    ]);
    const [y] = elementsIn(node, scope);
    expect(expandName(nameOf(y.node), scopeIn(y.node, y.scope))).toEqual({ namespace: undefined, local: 'y' });
  });

  it('reads WordprocessingML and markup compatibility by namespace, whatever their prefixes', () => {
    const { node, scope } = root('<localw:sectPr xmlns:localw="' + W + '" xmlns:w="urn:other" xmlns:compat="' + MARKUP_COMPATIBILITY + '">'
      + '<localw:pgSz localw:w="11906" w:w="1"/><compat:AlternateContent/></localw:sectPr>');
    expect(isNamed(node, scope, WORDPROCESSINGML, 'sectPr')).toBe(true);
    const [pgSz, alternatives] = elementsIn(node, scope);
    expect(attributeNamed(pgSz.node, pgSz.scope, WORDPROCESSINGML, 'w')).toBe('11906');
    expect(attributeNamed(pgSz.node, pgSz.scope, 'urn:other', 'w')).toBe('1');
    expect(isNamed(alternatives.node, alternatives.scope, MARKUP_COMPATIBILITY, 'AlternateContent')).toBe(true);
  });

  it('names a section property by its local name in WordprocessingML, and ranks it in CT_SectPr\'s order', () => {
    const { node, scope } = root('<w:sectPr xmlns:w="' + W + '" xmlns:x="urn:x"><w:footerReference/><x:pgSz/><w:cols/>text</w:sectPr>');
    const children = (node['w:sectPr'] as typeof node[]).map(child => sectPrPropertyOf(child, scopeIn(node, scope)));
    expect(children).toEqual(['footerReference', '', 'cols', '']);
    expect([sectPrRank('footerReference'), sectPrRank('headerReference'), sectPrRank('pgSz') < sectPrRank('cols'), sectPrRank('')]).toEqual([0, 0, true, -1]);
  });

  it('keeps the scope around an element apart from the one inside it', () => {
    const outer: Scope = new Map([['p', 'urn:outer']]);
    const { node } = root('<p:x xmlns:p="urn:inner"/>');
    expect(scopeIn(node, outer).get('p')).toBe('urn:inner');
    expect(outer.get('p')).toBe('urn:outer');
  });

  it('moves a node to another context with the declarations and markup compatibility\'s settings it uses there, but those it has itself', () => {
    const from: Context = {
      scope: new Map([['w', W], ['x', 'urn:x'], ['y', 'urn:y'], ['mc', MARKUP_COMPATIBILITY], ['', 'urn:d']]),
      compatibility: { ...NO_COMPATIBILITY, ignorable: new Set(['urn:x', 'urn:y']), processContent: new Set(['urn:x wrap', 'urn:y wrap']) },
    };
    const to: Context = { scope: new Map([['w', 'urn:other'], ['mc', MARKUP_COMPATIBILITY]]), compatibility: NO_COMPATIBILITY };
    const move = (xml: string) => buildOrdered([moved(parseOrdered(xml)![0], from, to)]);
    // What it uses, but y, which it doesn't, and wrappers only of the
    // namespaces of the elements it holds
    expect(move('<w:pgNumType w:fmt="lowerRoman" x:hint="1"/>')).toBe('<w:pgNumType w:fmt="lowerRoman" x:hint="1" xmlns:w="' + W + '" xmlns:x="urn:x" mc:Ignorable="x"/>');
    expect(move('<w:sectPrChange><w:sectPr><x:wrap/></w:sectPr></w:sectPrChange>'))
      .toBe('<w:sectPrChange xmlns:w="' + W + '" xmlns:x="urn:x" mc:Ignorable="x" mc:ProcessContent="x:wrap"><w:sectPr><x:wrap/></w:sectPr></w:sectPrChange>');
    // Its default namespace, and a prefix it declares itself
    expect(move('<extra/>')).toBe('<extra xmlns="urn:d"/>');
    expect(move('<w:titlePg xmlns:w="urn:mine"/>')).toBe('<w:titlePg xmlns:w="urn:mine"/>');
    // A namespace it makes ignorable where no prefix is bound to it, by a new one
    const into: Context = { scope: new Map([['w', W]]), compatibility: NO_COMPATIBILITY };
    expect(buildOrdered([moved(parseOrdered('<w:cols><w:col xmlns:z="urn:x" z:a="1"/></w:cols>')![0], from, into)]))
      .toBe('<w:cols xmlns:ns1="urn:x" xmlns:ns2="' + MARKUP_COMPATIBILITY + '" ns2:Ignorable="ns1"><w:col xmlns:z="urn:x" z:a="1"/></w:cols>');
    const node = parseOrdered('<w:titlePg/>')![0];
    expect(moved(node, from, from)).toBe(node);
  });

  it('keeps ignorable, moved, a namespace that only its markup compatibility lists name', () => {
    // The namespace counted as used only where a name was in it, so a
    // sectPr whose mc:ProcessContent named a wrapper of a namespace its
    // context made ignorable, and which held none, declared the prefix and
    // kept the list, but the namespace wasn't ignorable, against markup
    // compatibility, which needs mc:ProcessContent's namespaces ignorable
    const from: Context = { scope: new Map([['w', W], ['mc', MARKUP_COMPATIBILITY], ['x', 'urn:x']]), compatibility: { ...NO_COMPATIBILITY, ignorable: new Set(['urn:x']) } };
    for (const list of ['ProcessContent="x:wrap"', 'PreserveElements="x:kept"', 'PreserveAttributes="x:*"', 'MustUnderstand="x"']) {
      const [sectPr] = parseOrdered('<w:sectPr mc:' + list + '><w:pgSz/></w:sectPr>')!;
      expect(buildOrdered([moved(sectPr, from, EXPORT_CONTEXT)])).toBe('<w:sectPr mc:' + list + ' xmlns:x="urn:x" mc:Ignorable="x"><w:pgSz/></w:sectPr>');
      expect(compatibilityProblems([effectiveSectPr(sectPr, from)], EXPORT_CONTEXT)).toEqual([]);
    }
    // A namespace mc:MustUnderstand names that Word doesn't understand makes
    // Word reject the document, so the sectPr as Word reads it in export's
    // document leaves it out of the list, but keeps the others
    const w14: Context = { ...from, scope: new Map([...from.scope, ['w14', 'http://schemas.microsoft.com/office/word/2010/wordml']]) };
    const [sectPr] = parseOrdered('<w:sectPr mc:MustUnderstand="x w14"><w:pgSz/></w:sectPr>')!;
    expect(buildOrdered([effectiveSectPr(sectPr, w14)])).toBe('<w:sectPr mc:MustUnderstand="w14"><w:pgSz/></w:sectPr>');
    const [only] = parseOrdered('<w:sectPr mc:MustUnderstand="x"><w:pgSz/></w:sectPr>')!;
    expect(buildOrdered([effectiveSectPr(only, from)])).toBe('<w:sectPr><w:pgSz/></w:sectPr>');
    // But not where a choice that requires it holds it, which Word reads
    // only where it understands it, as a tracked change's old properties can
    const [tracked] = parseOrdered('<w:sectPr><w:sectPrChange><w:sectPr><mc:AlternateContent><mc:Choice Requires="x"><w:pgSz mc:MustUnderstand="x"/></mc:Choice></mc:AlternateContent></w:sectPr></w:sectPrChange></w:sectPr>')!;
    expect(buildOrdered([effectiveSectPr(tracked, from)])).toContain('<w:pgSz mc:MustUnderstand="x"/>');
  });

  it('moves a node with the elements and attributes that mc:PreserveElements and mc:PreserveAttributes name in its context, of the namespaces of those it holds, as it does mc:ProcessContent\'s wrappers', () => {
    // It took only mc:Ignorable's and mc:ProcessContent's, so a consumer
    // that edits what it was moved into could drop what the others keep
    const from: Context = {
      scope: new Map([['w', W], ['mc', MARKUP_COMPATIBILITY], ['e', 'urn:e'], ['f', 'urn:f']]),
      compatibility: { ...NO_COMPATIBILITY, ignorable: new Set(['urn:e', 'urn:f']), preserveElements: new Set(['urn:e keep', 'urn:f keep']), preserveAttributes: new Set(['urn:e hint', 'urn:f *']) },
    };
    const move = (xml: string) => buildOrdered([moved(parseOrdered(xml)![0], from, EXPORT_CONTEXT)]);
    expect(move('<w:pgMar w:top="1" e:hint="1"/>')).toBe('<w:pgMar w:top="1" e:hint="1" xmlns:e="urn:e" mc:Ignorable="e" mc:PreserveAttributes="e:hint"/>');
    expect(move('<w:pgSz><e:keep/></w:pgSz>')).toBe('<w:pgSz xmlns:e="urn:e" mc:Ignorable="e" mc:PreserveElements="e:keep"><e:keep/></w:pgSz>');
    expect(move('<w:cols f:a="1"/>')).toBe('<w:cols f:a="1" xmlns:f="urn:f" mc:Ignorable="f" mc:PreserveAttributes="f:*"/>');
  });

  it('keeps what an element Word ignores holds as it is, markup compatibility\'s alternatives too, where mc:PreserveElements keeps it', () => {
    const opaque = '<e:opaque><mc:AlternateContent><mc:Choice Requires="e"><e:a/></mc:Choice><mc:Fallback><w:b/></mc:Fallback></mc:AlternateContent></e:opaque>';
    const xml = '<w:sectPr xmlns:w="' + W + '" xmlns:mc="' + MARKUP_COMPATIBILITY + '" xmlns:e="urn:e" mc:Ignorable="e" mc:PreserveElements="e:opaque"><w:pgSz w:w="1"/>' + opaque + '</w:sectPr>';
    const [sectPr] = parseOrdered(xml, NONE)!;
    expect(buildOrdered([effectiveSectPr(sectPr, { scope: NONE, compatibility: NO_COMPATIBILITY })]))
      .toBe('<w:sectPr xmlns:e="urn:e" mc:Ignorable="e" mc:PreserveElements="e:opaque"><w:pgSz w:w="1"/>' + opaque + '</w:sectPr>');
  });

  it('reads mc:PreserveElements and mc:PreserveAttributes into the settings in an element, and keeps them on what a choice or a wrapper Word reads held', () => {
    const xml = '<w:sectPr xmlns:w="' + W + '" xmlns:mc="' + MARKUP_COMPATIBILITY + '" xmlns:w14="' + W14 + '" xmlns:e="urn:e" xmlns:x="urn:x" mc:Ignorable="e x" mc:ProcessContent="x:wrap">'
      + '<mc:AlternateContent><mc:Choice Requires="w14" mc:PreserveAttributes="e:hint"><w:pgMar w:top="1" e:hint="1"/></mc:Choice><mc:Fallback/></mc:AlternateContent>'
      + '<x:wrap mc:PreserveElements="e:keep e:*"><e:keep/></x:wrap></w:sectPr>';
    const [sectPr] = parseOrdered(xml, NONE)!;
    const wrapper = childrenOf(sectPr)[1];
    expect(compatibilityIn(wrapper, scopeIn(sectPr, NONE), NO_COMPATIBILITY)).toEqual({ ...NO_COMPATIBILITY, preserveElements: new Set(['urn:e keep', 'urn:e *']) });
    const effective = effectiveSectPr(sectPr, { scope: NONE, compatibility: NO_COMPATIBILITY });
    expect(buildOrdered([effective])).toBe('<w:sectPr xmlns:w14="' + W14 + '" xmlns:e="urn:e" xmlns:x="urn:x" mc:Ignorable="e x" mc:ProcessContent="x:wrap">'
      + '<w:pgMar w:top="1" e:hint="1" mc:PreserveAttributes="e:hint"/><e:keep mc:PreserveElements="e:keep e:*"/></w:sectPr>');
    expect(compatibilityProblems([effective], EXPORT_CONTEXT)).toEqual([]);
  });

  // Each of markup compatibility's lists, read, moved and checked through
  // the one list of them, so that a reader or writer can leave none out
  it.each(COMPATIBILITY_LISTS.map(list => [list.local, list] as const))('reads, moves and checks mc:%s as COMPATIBILITY_LISTS has it', (local, list) => {
    const token = list.of === 'namespaces' ? 'e' : 'e:thing';
    const holding = list.of === 'elements' ? '<w:pgMar><e:thing/></w:pgMar>' : '<w:pgMar e:thing="1"/>';
    const scope: Scope = new Map([['w', W], ['mc', MARKUP_COMPATIBILITY], ['e', 'urn:e']]);
    const [node] = parseOrdered('<w:sectPr mc:' + local + '="' + token + '"/>')!;
    const entry = list.of === 'namespaces' ? 'urn:e' : 'urn:e thing';
    const read = compatibilityIn(node, scope, NO_COMPATIBILITY);
    expect(read).toEqual(list.setting ? { ...NO_COMPATIBILITY, [list.setting]: new Set([entry]) } : NO_COMPATIBILITY);
    // Moved out of where the setting is, into export's document, with it
    const from: Context = { scope, compatibility: { ...read, ignorable: new Set(['urn:e']) } };
    const written = buildOrdered([moved(parseOrdered(holding)![0], from, EXPORT_CONTEXT)]);
    expect(written.includes(' mc:' + local + '="' + token + '"')).toBe(list.setting !== undefined);
    // Where what it names isn't ignorable or understood, as it needs
    const problems = documentCompatibilityProblems('<w:document xmlns:w="' + W + '" xmlns:mc="' + MARKUP_COMPATIBILITY + '" xmlns:e="urn:e" mc:' + local + '="' + token + '"/>');
    expect(problems).toEqual(list.needs === 'ignorable' ? ['not ignorable ' + token + ' in mc:' + local + ' on w:document'] : list.needs === 'understood' ? ['not understood ' + token + ' in mc:' + local + ' on w:document'] : []);
  });

  it('finds a namespace mc:MustUnderstand names that Word doesn\'t understand, ignorable or not, but in a choice that requires it', () => {
    // Which a consumer that doesn't understand it rejects the document for,
    // ignorable or not, so only its prefix's being bound was checked
    const document = (inner: string) => '<w:document xmlns:w="' + W + '" xmlns:mc="' + MARKUP_COMPATIBILITY + '" xmlns:x="urn:x" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="x w14">' + inner + '</w:document>';
    expect(documentCompatibilityProblems(document('<w:body mc:MustUnderstand="x"/>'))).toEqual(['not understood x in mc:MustUnderstand on w:body']);
    expect(documentCompatibilityProblems(document('<w:body mc:MustUnderstand="w14"/>'))).toEqual([]);
    expect(documentCompatibilityProblems(document('<mc:AlternateContent><mc:Choice Requires="x"><w:body mc:MustUnderstand="x"/></mc:Choice><mc:Fallback><w:body/></mc:Fallback></mc:AlternateContent>'))).toEqual([]);
    expect(documentCompatibilityProblems(document('<mc:AlternateContent><mc:Choice Requires="x"><w:body/></mc:Choice><mc:Fallback><w:body mc:MustUnderstand="x"/></mc:Fallback></mc:AlternateContent>')))
      .toEqual(['not understood x in mc:MustUnderstand on w:body']);
  });

  it('names xml\'s namespace by xml, which no other prefix can be bound to, where a node moved makes it ignorable', () => {
    // A namespace no prefix in scope was bound to got one of its own, as
    // ns1, but xml's, which xml is bound to without a declaration, and which
    // no other prefix can be bound to (Namespaces in XML 1.0 §3)
    const from: Context = { scope: new Map([['w', W], ['mc', MARKUP_COMPATIBILITY]]), compatibility: { ...NO_COMPATIBILITY, ignorable: new Set([XML_NAMESPACE]) } };
    const [sectPr] = parseOrdered('<w:sectPr mc:MustUnderstand="xml"><w:pgSz/></w:sectPr>')!;
    const effective = effectiveSectPr(sectPr, from);
    expect(buildOrdered([effective])).toBe('<w:sectPr mc:MustUnderstand="xml" mc:Ignorable="xml"><w:pgSz/></w:sectPr>');
    expect(compatibilityProblems([effective], EXPORT_CONTEXT)).toEqual([]);
  });

  it('reads nothing of a sectPr that breaks Namespaces in XML, there or within, in the scope it is in, so export never writes what does', () => {
    // A declaration of the default namespace too, which moved and canonical
    // write as they read it
    const sectPr = (declarations: string, inner = '<w:pgSz/>') => '<w:sectPr xmlns:w="' + W + '"' + declarations + '>' + inner + '</w:sectPr>';
    const reserved = [XML_NAMESPACE, XMLNS_NAMESPACE].flatMap(namespace => [' xmlns="' + namespace + '"', ' xmlns:p="' + namespace + '"']).concat(' xmlns:xml="urn:x"', ' xmlns:xmlns="urn:x"');
    // And a prefix undeclared, which moved and canonical would write too
    for (const declarations of [...reserved, ' xmlns:p=""']) {
      expect(parseOrdered(sectPr(declarations))).toBeUndefined();
      expect(parseOrdered(sectPr('', '<w:pgSz' + declarations + '/>'))).toBeUndefined();
    }
    expect(parseOrdered(sectPr('', '<xmlns:pgSz/>'))).toBeUndefined();
    // A prefix that nothing binds, of an element or an attribute, which a
    // part read without its scope takes as bound outside it
    for (const inner of ['<x:ext/>', '<w:pgSz x:a="1"/>']) {
      expect(parseOrdered(sectPr('', inner), NONE)).toBeUndefined();
      expect(parseOrdered(sectPr('', inner), new Map([['x', 'urn:x']]))).toBeDefined();
      expect(parseOrdered(sectPr('', inner))).toBeDefined();
    }
    // Two attributes of one expanded name
    expect(parseOrdered(sectPr(' xmlns:v="' + W + '"', '<w:pgSz w:w="1" v:w="2"/>'), NONE)).toBeUndefined();
    // But xml bound to its own namespace, which it may be
    const [allowed] = parseOrdered(sectPr(' xmlns:xml="' + XML_NAMESPACE + '"', '<w:pgSz xml:lang="en"/>'), NONE)!;
    const effective = effectiveSectPr(allowed, { scope: NONE, compatibility: NO_COMPATIBILITY });
    expect(buildOrdered([effective])).toBe('<w:sectPr xmlns:xml="' + XML_NAMESPACE + '"><w:pgSz xml:lang="en"/></w:sectPr>');
    expect(compatibilityProblems([effective], EXPORT_CONTEXT)).toEqual([]);
  });

  it('reads none of a sectPr with Strict\'s and Transitional\'s attribute of one local name on an element, which Word reads as one, and export would write as one', () => {
    // Export wrote the later of the two, under w:
    const STRICT = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
    const xml = (pgSz: string) => '<w:sectPr xmlns:w="' + W + '" xmlns:s="' + STRICT + '">' + pgSz + '</w:sectPr>';
    expect(parseOrdered(xml('<w:pgSz w:w="1" s:w="2"/>'), NONE)).toBeUndefined();
    expect(compatibilityProblems(xmlParser(ORDERED_OPTIONS).parse(xml('<w:pgSz w:w="1" s:w="2"/>')) as XmlNode[], { scope: NONE, compatibility: NO_COMPATIBILITY }))
      .toEqual(['repeated s:w on w:pgSz']);
    // Either alone, which effectiveSectPr writes under w:
    for (const pgSz of ['<w:pgSz w:w="1"/>', '<s:pgSz s:w="1"/>']) {
      const effective = effectiveSectPr(parseOrdered(xml(pgSz), NONE)![0], { scope: NONE, compatibility: NO_COMPATIBILITY });
      expect(buildOrdered([effective])).toBe('<w:sectPr><w:pgSz w:w="1"/></w:sectPr>');
    }
  });

  it('reads a document of more than a thousand references to entities, as export writes one, and so does the checker', async () => {
    // The parser's default limit of a thousand, of which every &lt;, &gt;,
    // &quot; and &apos; counts, refused it
    const { docx } = await convertMdToDocx(Array.from({ length: 600 }, (_, i) => 'A < B > C ' + i).join('\n\n'));
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml.match(/&(?:lt|gt|quot|apos);/g)!.length).toBeGreaterThan(1000);
    expect(parseOrdered(xml, NONE)).toBeDefined();
    expect(documentCompatibilityProblems(xml)).toEqual([]);
  });

  it('finds nothing in an element the consumer discards, nor in its attributes, but in what a wrapper holds, as the consumer given reads it', () => {
    const document = (declarations: string, inner: string) => '<w:document xmlns:w="' + W + '" xmlns:mc="' + MARKUP_COMPATIBILITY + '" xmlns:x="urn:x" xmlns:y="urn:y" xmlns:w14="' + W14 + '"' + declarations + '>' + inner + '</w:document>';
    // The attributes of an element it discards went unread, but were
    // checked, as a y:hint, whose namespace isn't ignorable
    expect(documentCompatibilityProblems(document(' mc:Ignorable="x"', '<x:ignored y:hint="1"><y:child/></x:ignored>'))).toEqual([]);
    expect(documentCompatibilityProblems(document(' mc:Ignorable="x"', '<w:body y:hint="1"/>'))).toEqual(['not ignorable y:hint on w:body']);
    // A wrapper of w14, for a consumer that doesn't understand w14, was
    // known by Word's understanding, so not as a wrapper, whose content went
    // unread, where it reads it
    const wrapped = document(' mc:Ignorable="w14" mc:ProcessContent="w14:wrap"', '<w14:wrap><y:child/></w14:wrap>');
    expect(documentCompatibilityProblems(wrapped, new Set([...WORD_UNDERSTOOD_NAMESPACES].filter(namespace => namespace !== W14)))).toEqual(['not ignorable y:child']);
    // Word, which understands w14, reads it and what it holds
    expect(documentCompatibilityProblems(wrapped)).toEqual(['not ignorable y:child']);
  });

  it('keeps ignorable, under export\'s prefix, a Strict namespace its context makes ignorable that markup compatibility\'s lists name', () => {
    // The names went under export's prefixes, Strict's WordprocessingML's
    // under w:, Transitional's, in mc:ProcessContent too, but the context's
    // ignorable namespaces stayed Strict's, so the one w: is bound to was
    // ignorable nowhere, against markup compatibility
    const STRICT = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
    const around: Context = { scope: new Map([['p', STRICT], ['mc', MARKUP_COMPATIBILITY]]), compatibility: { ...NO_COMPATIBILITY, ignorable: new Set([STRICT]) } };
    const [sectPr] = parseOrdered('<p:sectPr mc:ProcessContent="p:wrap"><p:pgSz/></p:sectPr>')!;
    expect(buildOrdered([canonical(sectPr, around)])).toBe('<w:sectPr mc:ProcessContent="w:wrap" mc:Ignorable="w"><w:pgSz/></w:sectPr>');
    expect(compatibilityProblems([canonical(sectPr, around)], EXPORT_CONTEXT)).toEqual([]);
    expect(compatibilityProblems([effectiveSectPr(sectPr, around)], EXPORT_CONTEXT)).toEqual([]);
  });

  it('takes, of markup compatibility\'s alternatives, the first choice that needs only what Word understands, or else the fallback, or else none', () => {
    const alternatives = (xml: string) => parseOrdered('<mc:AlternateContent xmlns:mc="' + MARKUP_COMPATIBILITY + '" xmlns:x="urn:x">' + xml + '</mc:AlternateContent>')![0];
    const chosen = (xml: string) => {
      const branch = chosenBranch(alternatives(xml), EXPORT_NAMESPACES);
      return branch && buildOrdered([branch]);
    };
    expect(chosen('<mc:Choice Requires="x"><a/></mc:Choice><mc:Choice Requires="w14 w15"><b/></mc:Choice><mc:Fallback><c/></mc:Fallback>')).toBe('<mc:Choice Requires="w14 w15"><b/></mc:Choice>');
    expect(chosen('<mc:Choice Requires="x w14"><a/></mc:Choice><mc:Fallback><c/></mc:Fallback>')).toBe('<mc:Fallback><c/></mc:Fallback>');
    // A prefix the choice binds to a namespace Word understands
    expect(chosen('<mc:Choice xmlns:x="' + W + '" Requires="x"><a/></mc:Choice>')).toBe('<mc:Choice xmlns:x="' + W + '" Requires="x"><a/></mc:Choice>');
    expect(chosen('<mc:Choice Requires="x"><a/></mc:Choice>')).toBeUndefined();
  });

  it('reads a choice that needs xml\'s namespace, which no document declares, or another Word understands that export\'s document doesn\'t bind', () => {
    // Word was taken to understand only what export's document element
    // binds, and xml, bound to no prefix in scope, to be unbound, so a
    // choice of an A4 page that needs DrawingML's namespace, or xml's, both
    // of which Word reads, gave the fallback's Letter
    const sectPr = (requires: string, declaration: string) => parseOrdered('<w:sectPr xmlns:w="' + W + '" xmlns:mc="' + MARKUP_COMPATIBILITY + '"' + declaration + '><mc:AlternateContent>'
      + '<mc:Choice Requires="' + requires + '"><w:pgSz w:w="11906" w:h="16838"/></mc:Choice><mc:Fallback><w:pgSz w:w="12240" w:h="15840"/></mc:Fallback></mc:AlternateContent></w:sectPr>')![0];
    const page = (requires: string, declaration = '') => /<w:pgSz\b[^>]*>/.exec(buildOrdered([effectiveSectPr(sectPr(requires, declaration), { scope: NONE, compatibility: NO_COMPATIBILITY })]))?.[0];
    expect(page('xml')).toBe('<w:pgSz w:w="11906" w:h="16838"/>');
    expect(page('a', ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"')).toBe('<w:pgSz w:w="11906" w:h="16838"/>');
    expect(page('w16du', ' xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du"')).toBe('<w:pgSz w:w="11906" w:h="16838"/>');
    // Nor one that needs wp15, which Word has read since Word 2013, and
    // which the set left out, so the choice went for its fallback
    expect(page('wp15', ' xmlns:wp15="http://schemas.microsoft.com/office/word/2012/wordprocessingDrawing"')).toBe('<w:pgSz w:w="11906" w:h="16838"/>');
    // But not one it doesn't
    expect(page('x', ' xmlns:x="urn:example:x"')).toBe('<w:pgSz w:w="12240" w:h="15840"/>');
    // Word understands every namespace export's document binds, which
    // isn't every namespace it understands
    for (const namespace of EXPORT_NAMESPACES.values()) expect(WORD_UNDERSTOOD_NAMESPACES.has(namespace)).toBe(true);
  });

  it('understands every namespace Word declares on the document element it writes, in the documents Word saved', async () => {
    // Word declares oel, [MS-OEXTXML]'s, without making it ignorable,
    // which the set left out
    const declared = new Set<string>();
    for (const name of ['comments', 'formatting_sample', 'replies', 'tables']) {
      const zip = await JSZip.loadAsync(readFileSync('test/fixtures/' + name + '.docx'));
      const xml = await zip.file('word/document.xml')!.async('string');
      const [document] = parseOrdered(xml.slice(xml.indexOf('<w:document')), NONE)!.filter(isElement);
      for (const [prefix, namespace] of scopeIn(document, NONE)) if (prefix !== 'xml') declared.add(namespace);
    }
    expect(declared.size).toBeGreaterThan(30);
    expect([...declared].filter(namespace => !WORD_UNDERSTOOD_NAMESPACES.has(namespace))).toEqual([]);
  });

  it('knows an ignorable element Word doesn\'t understand, which mc:ProcessContent names, as a wrapper whose content Word reads', () => {
    const MC = 'xmlns:mc="' + MARKUP_COMPATIBILITY + '"';
    const wrappers = (xml: string) => {
      const [node] = parseOrdered(xml)!;
      const compatibility = compatibilityIn(node, EXPORT_NAMESPACES, NO_COMPATIBILITY);
      return elementsIn(node, EXPORT_NAMESPACES).map(child => isProcessedWrapper(child.node, child.scope, compatibility));
    };
    expect(wrappers('<w:sectPr ' + MC + ' xmlns:ext="urn:ext" mc:Ignorable="ext" mc:ProcessContent="ext:wrap"><ext:wrap/><ext:other/><w:cols/></w:sectPr>')).toEqual([true, false, false]);
    // Any of its namespace, by another prefix, and named on the element itself
    expect(wrappers('<w:sectPr ' + MC + ' xmlns:ext="urn:ext" mc:Ignorable="ext" mc:ProcessContent="ext:*"><e:wrap xmlns:e="urn:ext"/><ext:wrap mc:ProcessContent="ext:wrap"/></w:sectPr>')).toEqual([true, true]);
    // Not ignorable, or of a namespace Word understands
    expect(wrappers('<w:sectPr ' + MC + ' xmlns:ext="urn:ext" mc:ProcessContent="ext:wrap"><ext:wrap/></w:sectPr>')).toEqual([false]);
    expect(wrappers('<w:sectPr ' + MC + ' mc:Ignorable="w14" mc:ProcessContent="w14:wrap"><w14:wrap/></w:sectPr>')).toEqual([false]);
    // An element Word ignores with all it holds: ignorable, of a namespace
    // it doesn't understand, and no wrapper
    const ignored = (xml: string) => {
      const [node] = parseOrdered(xml)!;
      const compatibility = compatibilityIn(node, EXPORT_NAMESPACES, NO_COMPATIBILITY);
      return elementsIn(node, EXPORT_NAMESPACES).map(child => isIgnored(child.node, child.scope, compatibility));
    };
    expect(ignored('<w:sectPr ' + MC + ' xmlns:ext="urn:ext" mc:Ignorable="ext w14" mc:ProcessContent="ext:wrap"><ext:wrap/><ext:other/><w14:other/><w:cols/><e:other xmlns:e="urn:e"/></w:sectPr>'))
      .toEqual([false, true, false, false, false]);
    // Nor one of a namespace a choice Word reads requires
    const [sectPr] = parseOrdered('<w:sectPr ' + MC + ' xmlns:ext="urn:ext" mc:Ignorable="ext"><ext:other/></w:sectPr>')!;
    const [other] = elementsIn(sectPr, EXPORT_NAMESPACES);
    expect(isIgnored(other.node, other.scope, compatibilityIn(sectPr, EXPORT_NAMESPACES, NO_COMPATIBILITY), new Set(['urn:ext']))).toBe(false);
  });

  it('reads an element as Word does, with markup compatibility\'s alternatives and wrappers in it in place of what Word reads of them', () => {
    const MC = 'xmlns:mc="' + MARKUP_COMPATIBILITY + '"';
    const resolved = (xml: string) => buildOrdered([resolvedNode(parseOrdered(xml)![0], EXPORT_CONTEXT)]);
    // The choice or fallback Word reads, at any depth, but not in a tracked
    // change's old properties, which keep theirs
    const change = '<w:sectPrChange><w:sectPr><mc:AlternateContent><mc:Fallback><w:pgMar/></mc:Fallback></mc:AlternateContent></w:sectPr></w:sectPrChange>';
    expect(resolved('<w:sectPr ' + MC + '><mc:AlternateContent><mc:Choice Requires="w14"><w:pgSz/><mc:AlternateContent><mc:Choice Requires="x" xmlns:x="urn:x"><w:cols w:num="3"/></mc:Choice>'
      + '<mc:Fallback><w:cols w:num="2"/></mc:Fallback></mc:AlternateContent></mc:Choice><mc:Fallback><w:pgMar/></mc:Fallback></mc:AlternateContent>' + change + '</w:sectPr>'))
      .toBe('<w:sectPr ' + MC + '><w:pgSz/><w:cols w:num="2"/>' + change + '</w:sectPr>');
    // What comes out of them keeps what they declare and make ignorable
    expect(resolved('<w:sectPr ' + MC + '><mc:AlternateContent xmlns:x="urn:x" mc:Ignorable="x"><mc:Choice Requires="w14"><w:cols x:y="1"/></mc:Choice></mc:AlternateContent></w:sectPr>'))
      .toBe('<w:sectPr ' + MC + '><w:cols x:y="1" xmlns:x="urn:x" mc:Ignorable="x"/></w:sectPr>');
    // A wrapper whose content Word reads as its parent's, in its place
    const wrapping = '<w:sectPr ' + MC + ' xmlns:ext="urn:ext" mc:Ignorable="ext" mc:ProcessContent="ext:wrap">';
    expect(resolved(wrapping + '<ext:wrap><w:cols w:num="2"/></ext:wrap><ext:other/></w:sectPr>')).toBe(wrapping + '<w:cols w:num="2"/><ext:other/></w:sectPr>');
    // A tracked change's old properties out of a wrapper keep the wrappers
    // it names, as one they hold, which Word reads too
    expect(resolved(wrapping + '<ext:wrap mc:ProcessContent="ext:inner"><w:sectPrChange><w:sectPr><ext:inner><w:pgMar/></ext:inner></w:sectPr></w:sectPrChange></ext:wrap></w:sectPr>'))
      .toBe(wrapping + '<w:sectPrChange mc:ProcessContent="ext:inner"><w:sectPr><ext:inner><w:pgMar/></ext:inner></w:sectPr></w:sectPrChange></w:sectPr>');
  });

  it('keeps what an extension holds as it is, alternatives too, which the application that knows the extension reads, not markup compatibility, as the checker does', () => {
    // Alternatives in it with only a choice Word doesn't read went
    const DRAWINGML = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const xml = '<w:pgSz xmlns:mc="' + MARKUP_COMPATIBILITY + '" xmlns:a="' + DRAWINGML + '" xmlns:x="urn:x"><a:extLst><a:ext uri="{X}">'
      + '<mc:AlternateContent><mc:Choice Requires="x"><x:y/></mc:Choice></mc:AlternateContent></a:ext></a:extLst></w:pgSz>';
    const [node] = parseOrdered(xml)!;
    expect(buildOrdered([resolvedNode(node, EXPORT_CONTEXT)])).toBe(xml);
    expect(compatibilityProblems([node], EXPORT_CONTEXT)).toEqual([]);
  });

  it('keeps mc:MustUnderstand as it is in what an element Word ignores or an extension holds, which Word reads none of, as the checker does', () => {
    // The list there lost what Word doesn't understand, as a list Word
    // reads does, so a payload mc:PreserveElements keeps changed
    const DRAWINGML = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const held = '<w:pgSz w:w="1"><a:extLst><a:ext uri="{X}"><x:y mc:MustUnderstand="x"/></a:ext></a:extLst></w:pgSz><e:opaque><e:payload mc:MustUnderstand="e"/></e:opaque>';
    const open = ' xmlns:a="' + DRAWINGML + '" xmlns:e="urn:e" xmlns:x="urn:x" mc:Ignorable="e" mc:PreserveElements="e:opaque">';
    const xml = '<w:sectPr xmlns:w="' + W + '" xmlns:mc="' + MARKUP_COMPATIBILITY + '"' + open + held + '</w:sectPr>';
    expect(documentCompatibilityProblems(xml)).toEqual([]);
    const [sectPr] = parseOrdered(xml, NONE)!;
    expect(buildOrdered([effectiveSectPr(sectPr, { scope: NONE, compatibility: NO_COMPATIBILITY })])).toBe('<w:sectPr' + open + held + '</w:sectPr>');
  });

  it('reads the text a wrapper or a choice holds as Word does, in their place, as it reads the elements they hold', () => {
    // Only the elements came out of them, so a wrapper or choice that held
    // text, as in an extension's property, came out as nothing. One of a
    // namespace that isn't ignorable, which Word reads, as it ignores what
    // an ignorable one holds
    const MC = 'xmlns:mc="' + MARKUP_COMPATIBILITY + '"';
    const resolved = (xml: string) => buildOrdered([resolvedNode(parseOrdered(xml)![0], EXPORT_CONTEXT)]);
    const wrapping = '<w:sectPr ' + MC + ' xmlns:e="urn:e" xmlns:f="urn:f" mc:Ignorable="e" mc:ProcessContent="e:wrap">';
    expect(resolved(wrapping + '<f:prop><e:wrap>payload</e:wrap></f:prop></w:sectPr>')).toBe(wrapping + '<f:prop>payload</f:prop></w:sectPr>');
    expect(resolved(wrapping + '<f:prop><e:wrap>a<e:b/><![CDATA[c<d]]></e:wrap></f:prop></w:sectPr>')).toBe(wrapping + '<f:prop>a<e:b/>c&lt;d</f:prop></w:sectPr>');
    expect(resolved(wrapping + '<f:prop><mc:AlternateContent><mc:Choice Requires="w14">chosen</mc:Choice><mc:Fallback>fallen</mc:Fallback></mc:AlternateContent></f:prop></w:sectPr>'))
      .toBe(wrapping + '<f:prop>chosen</f:prop></w:sectPr>');
    // And a wrapper that holds text after its properties go stays, with it
    const [sectPr] = parseOrdered(wrapping + '<e:wrap>kept<w:titlePg/></e:wrap><e:wrap> <w:titlePg/></e:wrap></w:sectPr>')!;
    expect(buildOrdered(mapProperties(childrenOf(sectPr), contextIn(sectPr, EXPORT_CONTEXT), () => []))).toBe('<e:wrap>kept</e:wrap>');
  });

  it('writes an element under export\'s prefixes, whatever its context binds, and takes with it what it uses of that context', () => {
    const STRICT = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
    const around: Context = { scope: new Map([['q', W], ['w', 'urn:other'], ['e', 'urn:e'], ['m', MARKUP_COMPATIBILITY]]), compatibility: { ...NO_COMPATIBILITY, ignorable: new Set(['urn:e']) } };
    const [sectPr] = parseOrdered('<q:sectPr><q:cols q:num="2" w:x="1" e:y="2"/><m:AlternateContent><m:Choice Requires="e w"><q:pgMar/></m:Choice></m:AlternateContent>'
      + '<s:pgSz xmlns:s="' + STRICT + '" s:w="1"/><q:docGrid xmlns:w="urn:inner" w:z="3" m:Ignorable="w"/></q:sectPr>')!;
    // WordprocessingML's names under w:, Strict's too, markup
    // compatibility's under mc:, and w's other namespaces under a prefix
    // of their own, where they're declared, in its lists of prefixes too;
    // what it uses only its context declares, declared on it, and ignorable
    // where its context makes it so
    expect(buildOrdered([canonical(sectPr, around)])).toBe('<w:sectPr xmlns:ns1="urn:other" xmlns:e="urn:e" mc:Ignorable="e"><w:cols w:num="2" ns1:x="1" e:y="2"/>'
      + '<mc:AlternateContent><mc:Choice Requires="e ns1"><w:pgMar/></mc:Choice></mc:AlternateContent><w:pgSz w:w="1"/><w:docGrid xmlns:ns2="urn:inner" ns2:z="3" mc:Ignorable="ns2"/></w:sectPr>');
    // And read as Word reads it, which doesn't understand e
    expect(buildOrdered([effectiveSectPr(sectPr, around)])).toBe('<w:sectPr xmlns:ns1="urn:other" xmlns:e="urn:e" mc:Ignorable="e"><w:cols w:num="2" ns1:x="1" e:y="2"/>'
      + '<w:pgSz w:w="1"/><w:docGrid xmlns:ns2="urn:inner" ns2:z="3" mc:Ignorable="ns2"/></w:sectPr>');
  });

  it('visits each section property in a choice, a fallback or a wrapper Word reads the content of, but none within a property', () => {
    const MC = 'xmlns:mc="' + MARKUP_COMPATIBILITY + '"';
    const [sectPr] = parseOrdered('<w:sectPr ' + MC + ' xmlns:w="' + W + '" xmlns:e="urn:e" mc:Ignorable="e" mc:ProcessContent="e:wrap"><w:type w:val="continuous"/>'
      + '<mc:AlternateContent><mc:Choice Requires="w14"><w:type w:val="oddPage"/><w:titlePg/></mc:Choice><mc:Fallback><w:titlePg/></mc:Fallback></mc:AlternateContent>'
      + '<e:wrap><w:type w:val="evenPage"/></e:wrap><e:other><w:type w:val="evenPage"/></e:other><w:sectPrChange><w:sectPr><w:type w:val="oddPage"/></w:sectPr></w:sectPrChange></w:sectPr>')!;
    const visited: string[] = [];
    const nextPage = mapProperties(childrenOf(sectPr), contextIn(sectPr, { scope: NONE, compatibility: NO_COMPATIBILITY }), (node, context) => {
      visited.push(nameOf(node));
      return sectPrPropertyOf(node, context.scope) === 'type' ? parseOrdered('<w:type w:val="nextPage"/>')! : [node];
    });
    expect(visited).toEqual(['w:type', 'w:type', 'w:titlePg', 'w:titlePg', 'w:type', 'e:other', 'w:sectPrChange']);
    expect(buildOrdered(nextPage)).toBe('<w:type w:val="nextPage"/><mc:AlternateContent><mc:Choice Requires="w14"><w:type w:val="nextPage"/><w:titlePg/></mc:Choice><mc:Fallback><w:titlePg/></mc:Fallback></mc:AlternateContent>'
      + '<e:wrap><w:type w:val="nextPage"/></e:wrap><e:other><w:type w:val="evenPage"/></e:other><w:sectPrChange><w:sectPr><w:type w:val="oddPage"/></w:sectPr></w:sectPrChange>');
    // Alternatives and a wrapper left holding nothing go
    const titleless = mapProperties(childrenOf(sectPr), contextIn(sectPr, { scope: NONE, compatibility: NO_COMPATIBILITY }), (node, context) =>
      ['titlePg', 'type'].includes(sectPrPropertyOf(node, context.scope)) ? [] : [node]);
    expect(buildOrdered(titleless)).toBe('<e:other><w:type w:val="evenPage"/></e:other><w:sectPrChange><w:sectPr><w:type w:val="oddPage"/></w:sectPr></w:sectPrChange>');
  });

  it('visits whole an element a choice holds of a namespace the choice requires, which a consumer that reads the choice understands, though mc:ProcessContent names it', () => {
    // It took the element for a wrapper, as Word, which doesn't understand
    // its namespace, would, and went into it: so a visit that drops the
    // section's type dropped the type within, then the element left
    // holding nothing, and then the alternatives
    const [sectPr] = parseOrdered('<w:sectPr xmlns:mc="' + MARKUP_COMPATIBILITY + '" xmlns:w="' + W + '" xmlns:x="urn:x" mc:Ignorable="x" mc:ProcessContent="x:wrap">'
      + '<mc:AlternateContent><mc:Choice Requires="x"><x:wrap><w:type w:val="continuous"/></x:wrap></mc:Choice><mc:Fallback><w:type w:val="continuous"/></mc:Fallback></mc:AlternateContent>'
      + '<x:wrap><w:type w:val="oddPage"/></x:wrap></w:sectPr>')!;
    const visited: string[] = [];
    const typeless = mapProperties(childrenOf(sectPr), contextIn(sectPr, { scope: NONE, compatibility: NO_COMPATIBILITY }), (node, context) => {
      visited.push(nameOf(node));
      return sectPrPropertyOf(node, context.scope) === 'type' ? [] : [node];
    });
    // The choice's x:wrap whole, the fallback's type, and the type in the
    // wrapper outside the alternatives, which Word reads as the sectPr's
    expect(visited).toEqual(['x:wrap', 'w:type', 'w:type']);
    expect(buildOrdered(typeless)).toBe('<mc:AlternateContent><mc:Choice Requires="x"><x:wrap><w:type w:val="continuous"/></x:wrap></mc:Choice><mc:Fallback/></mc:AlternateContent>');
  });

  it('puts section properties among a sectPr\'s own in CT_SectPr\'s order, in place of those of their names, before the old ones a tracked change holds', () => {
    const [sectPr] = parseOrdered('<w:sectPr xmlns:w="' + W + '"><w:headerReference w:type="first"/><w:pgSz/><w:pgNumType w:start="1"/><w:cols/><x:ext xmlns:x="urn:x"/><w:sectPrChange/></w:sectPr>')!;
    const from: Context = { scope: new Map([['w', W], ['r', 'urn:r'], ['e', 'urn:e']]), compatibility: { ...NO_COMPATIBILITY, ignorable: new Set(['urn:e']) } };
    const added = parseOrdered('<w:titlePg/><w:pgNumType w:fmt="lowerRoman" e:hint="1"/><w:headerReference w:type="default" r:id="rId1"/><w:footerReference w:type="default"/>')!;
    expect(buildOrdered([withProperties(sectPr, { scope: NONE, compatibility: NO_COMPATIBILITY }, added, from)])).toBe('<w:sectPr xmlns:w="' + W + '">'
      + '<w:headerReference w:type="default" r:id="rId1" xmlns:r="urn:r"/><w:footerReference w:type="default"/><w:pgSz/>'
      + '<w:pgNumType w:fmt="lowerRoman" e:hint="1" xmlns:e="urn:e" xmlns:ns1="' + MARKUP_COMPATIBILITY + '" ns1:Ignorable="e"/><w:cols/><x:ext xmlns:x="urn:x"/><w:titlePg/><w:sectPrChange/></w:sectPr>');
  });


  it('puts section properties in place of those of their expanded names only, an extension\'s too, and keeps the rest', () => {
    // An extension's property, which isn't WordprocessingML's, took the
    // place of every other such property, and of the sectPr's text
    const [sectPr] = parseOrdered('<w:sectPr xmlns:w="' + W + '" xmlns:e="urn:e" xmlns:f="urn:f"><w:pgSz/>\n<e:existing/><f:added/><w:cols/><w:sectPrChange/></w:sectPr>')!;
    const from: Context = { scope: new Map([['w', W], ['e', 'urn:e'], ['f', 'urn:f'], ['g', 'urn:e']]), compatibility: NO_COMPATIBILITY };
    const added = parseOrdered('<e:added/><g:existing g:new="1"/>')!;
    // Of the same expanded name as e:existing, g:existing goes in its
    // place; and e:added, whose name is f:added's but for its namespace,
    // goes where CT_SectPr's properties end, before the tracked change's
    expect(buildOrdered([withProperties(sectPr, { scope: NONE, compatibility: NO_COMPATIBILITY }, added, from)])).toBe('<w:sectPr xmlns:w="' + W + '" xmlns:e="urn:e" xmlns:f="urn:f">'
      + '<w:pgSz/>\n<g:existing g:new="1" xmlns:g="urn:e"/><f:added/><w:cols/><e:added/><w:sectPrChange/></w:sectPr>');
  });

  it('reads no XML that isn\'t well-formed, and writes back what it reads', () => {
    expect(parseOrdered('<a><b></a>')).toBeUndefined();
    // An end tag closed as an empty element's, which the validator takes
    expect(parseOrdered('<a></b/></a>')).toBeUndefined();
    expect(parseOrdered('</a x="1"/>')).toBeUndefined();
    expect(parseOrdered('<a><!-- </b/> --><![CDATA[</b/>]]><?p </b/>?></a>')).toBeDefined();
    // And a byte order mark before the root, and a comment's start in a
    // section, which a check of what's outside the root took for text and
    // a comment
    expect(buildOrdered(parseOrdered('\uFEFF<a/>')!)).toBe('<a/>');
    expect(buildOrdered(parseOrdered('<a><![CDATA[<!--]]></a><!-- end -->')!)).toBe('<a>&lt;!--</a>');
    // Nor XML with a DOCTYPE, which no part of a package has, though it's
    // well-formed, whose entities were read otherwise than XML reads them
    expect(parseOrdered('<!DOCTYPE a [<!ENTITY t "\t">]><a b="&t;"/>')).toBeUndefined();
    expect(parseOrdered('<a><!-- <!DOCTYPE a> --></a>')).toBeDefined();
    const xml = '<w:sectPr xmlns:w="' + W + '" w:rsidR="00A1B2C3"><w:pgSz w:w="12240" w:h="15840"/><w:titlePg/></w:sectPr>';
    expect(buildOrdered(parseOrdered(xml)!)).toBe(xml);
  });

  it('reads none of XML with an element named as one of a JavaScript object\'s properties, which the parser renames or refuses', () => {
    // toString was read as __toString, and written so
    for (const name of ['toString', 'valueOf', 'hasOwnProperty', 'constructor', '__proto__']) expect(parseOrdered('<a><' + name + '/></a>')).toBeUndefined();
    // But an attribute of such a name, and an element with a prefix, which
    // the parser doesn't rename
    const xml = '<a toString="1" constructor="2"><p:toString xmlns:p="urn:p"/></a>';
    expect(buildOrdered(parseOrdered(xml)!)).toBe(xml);
  });

  it('reads none of XML with a character XML doesn\'t allow, or a reference to one, which the parser leaves as text', () => {
    for (const xml of ['<a>\u0000</a>', '<a b="\u0001"/>', '<a>\uD800</a>', '<a>\uFFFE</a>', '<a><!-- \u0000 --></a>', '<a>&#0;</a>', '<a b="&#x1;"/>', '<a>&#xD800;</a>', '<a>&#X110000;</a>', '<a>&#99999999999999999999;</a>']) {
      expect(parseOrdered(xml)).toBeUndefined();
    }
    // But what looks like one in a comment, a section or an instruction,
    // and a reference to a character XML allows, past U+FFFF too
    expect(parseOrdered('<a><!-- &#0; --><![CDATA[&#0;]]><?p &#0;?></a>')).toBeDefined();
    const xml = '<a b="&#9;">\u{10000}\uFFFD&#x10FFFF;</a>';
    expect(buildOrdered(parseOrdered(xml)!)).toBe('<a b="&#9;">\u{10000}\uFFFD\u{10FFFF}</a>');
  });

  it('reads none of XML with a space of Unicode\'s but XML\'s between names in a tag, which the parser reads as one, but reads it in text and values, and names past U+FFFF', () => {
    expect(parseOrdered('<a b="1"\u3000c="2"/>')).toBeUndefined();
    expect(parseOrdered('<a\u00A0b="1"/>')).toBeUndefined();
    for (const xml of ['<a b="1\u3000\u00A0\u2028">\u3000\u205F</a>', '<\u{10000}a xmlns="urn:x" \u{EFFFF}="1"/>']) expect(buildOrdered(parseOrdered(xml, NONE)!)).toBe(xml);
  });

  it('reads an attribute\'s value as XML does, white space as a space and a reference to a character as that character, and writes it back so', () => {
    // A reference was read as its text, and written with its & escaped
    const [pgMar] = parseOrdered('<w:pgMar xmlns:w="' + W + '" xmlns:e="urn:e" w:top="1440" e:lit="p\tq\r\nr\ns" e:ref="p&#9;q&#xA;r&#xD;s&#x2019;t&#38;u&amp;#9;&lt;&quot;"/>')!;
    expect(pgMar[':@']).toEqual({ '@_xmlns:w': W, '@_xmlns:e': 'urn:e', '@_w:top': '1440', '@_e:lit': 'p q r s', '@_e:ref': 'p\tq\nr\rs\u2019t&u&#9;<"' });
    expect(buildOrdered([pgMar])).toBe('<w:pgMar xmlns:w="' + W + '" xmlns:e="urn:e" w:top="1440" e:lit="p q r s" e:ref="p&#9;q&#xA;r&#xD;s\u2019t&amp;u&amp;#9;&lt;&quot;"/>');
    // Text keeps its white space, but a carriage return, which a reader
    // reads as a line feed where it isn't a reference
    const [ext] = parseOrdered('<e:x xmlns:e="urn:e">a&#x2019;b\tc\nd&#xD;e&amp;f&lt;<![CDATA[&amp;&#9;<]]></e:x>')!;
    expect(childrenOf(ext).map(text => text['#text']).join('')).toBe('a\u2019b\tc\nd\re&f<&amp;&#9;<');
    expect(buildOrdered([ext])).toBe('<e:x xmlns:e="urn:e">a\u2019b\tc\nd&#xD;e&amp;f&lt;&amp;amp;&amp;#9;&lt;</e:x>');
    // And markup compatibility's lists, apart by a tab written as one
    const [sectPr] = parseOrdered('<w:sectPr xmlns:w="' + W + '" xmlns:mc="' + MARKUP_COMPATIBILITY + '" xmlns:e="urn:e" mc:Ignorable="e" mc:ProcessContent="e:x&#9;e:y"/>')!;
    expect(compatibilityIn(sectPr, NONE, NO_COMPATIBILITY).processContent).toEqual(new Set(['urn:e x', 'urn:e y']));
  });

  it('keeps names past U+FFFF apart, which the validator reads by others', () => {
    // Each was read as a, so two attributes that differ in one were read as
    // repeated, and an end tag that doesn't match its start as matching it
    expect(buildOrdered(parseOrdered('<a \u{10000}="1" \u{10001}="2"/>', NONE)!)).toBe('<a \u{10000}="1" \u{10001}="2"/>');
    expect(parseOrdered('<\u{10000}a></\u{10001}a>', NONE)).toBeUndefined();
    // Nor are they read as a character the XML has
    expect(buildOrdered(parseOrdered('<a \u{10000}="1" \u3400="2" \u3401="3"/>', NONE)!)).toBe('<a \u{10000}="1" \u3400="2" \u3401="3"/>');
    expect(parseOrdered('<\u3400a></\u{10000}a>', NONE)).toBeUndefined();
  });

  it.each([
    ['a character that isn\'t a name\'s, U+F8FF, and one that is', '\uF8FF\uFDCF'],
    ['a character that isn\'t a name\'s, U+F8FF, and U+FFFF', '\uF8FF\uFFFF'],
    ['a name\'s first character and one no name has, U+FDD0', '\uF900\uFDD0'],
    ['a name\'s first character and U+FFFE', '\uF900\uFFFE'],
  ])('reads none of XML with a name of %s, by code point, which Bun 1.3.9\'s regular expressions read as one character a name can have', (_name, name) => {
    // Its regular expressions with the u flag read the two as one
    // character past U+FFFF, which the name check, and the substitution
    // for the validator, took for one a name can have
    expect(parseOrdered('<' + name + '/>', NONE)).toBeUndefined();
    expect(parseOrdered('<a ' + name + '="1"/>', NONE)).toBeUndefined();
    expect(parseOrdered('<a>\uF8FF\uFFFE</a>', NONE)).toBeUndefined();
    // Names of a name's characters at those edges are read
    expect(buildOrdered(parseOrdered('<\uF900\uFDCF \uFDF0\uFFFD="1">\uF8FF\uFFFD</\uF900\uFDCF>', NONE)!)).toBe('<\uF900\uFDCF \uFDF0\uFFFD="1">\uF8FF\uFFFD</\uF900\uFDCF>');
  });
});
