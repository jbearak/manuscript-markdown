import { describe, it, expect } from 'bun:test';
import { compatibilityProblems, documentCompatibilityProblems } from './markup-compatibility-check';
import { MARKUP_COMPATIBILITY, NO_COMPATIBILITY, ORDERED_OPTIONS, XMLNS_NAMESPACE, XML_NAMESPACE, type XmlNode } from './scoped-xml';
import { xmlParser } from './xml-parser';

// The versions of markup of the examples in ECMA-376 Part 3 (Part 5 of the
// first edition), §10.1 and §10.2, and consumers of each, each of which
// understands its version and those before it
const C1 = 'http://schemas.openxmlformats.org/Circles/v1';
const C2 = 'http://schemas.openxmlformats.org/Circles/v2';
const C3 = 'http://schemas.openxmlformats.org/Circles/v3';
const V1 = new Set([C1]), V2 = new Set([C1, C2]), V3 = new Set([C1, C2, C3]);
const DRAWINGML = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const ROOT = '<Circles xmlns="' + C1 + '" xmlns:mc="' + MARKUP_COMPATIBILITY + '" xmlns:v2="' + C2 + '" xmlns:v3="' + C3 + '"';
const circle = (center: string, color: string, more = '') => '<Circle Center="' + center + '" Radius="20" Color="' + color + '"' + more + '/>';

// The rules of Namespaces in XML 1.0, each broken, and the lines that name
// it. Of reserved names (§3): xml is bound to xml's namespace, and may be
// declared so, but to no other; xmlns, to its own, may not be declared, nor
// prefix an element's name; and neither namespace is bound to another
// prefix, or as the default. A prefix's declaration has a namespace (§5),
// and a name's prefix is bound (§5), within an element a consumer ignores
// too. An element's attributes have an expanded name each (§6.3). An
// element's or an attribute's name, a declaration's too, is a QName, of
// XML's names (XML 1.0 §2.3) with a colon only between a prefix and the
// local name, and a prefix declared is an NCName, with none (§3, §4).
const NAMESPACE_RULES: Array<[string, string, string[]]> = [
  ['xml\'s namespace bound to another prefix', '<Circles xmlns="' + C1 + '" xmlns:ns1="' + XML_NAMESPACE + '"/>', ['reserved xmlns:ns1 on Circles']],
  ['xml\'s namespace as the default', '<Circles xmlns="' + XML_NAMESPACE + '"/>', ['reserved xmlns on Circles']],
  ['xml bound to another namespace', '<Circles xmlns="' + C1 + '" xmlns:xml="urn:x"/>', ['reserved xmlns:xml on Circles']],
  ['xmlns declared', '<Circles xmlns="' + C1 + '" xmlns:xmlns="urn:x"/>', ['reserved xmlns:xmlns on Circles']],
  ['xmlns\'s namespace bound to another prefix', '<Circles xmlns="' + C1 + '" xmlns:ns1="' + XMLNS_NAMESPACE + '"/>', ['reserved xmlns:ns1 on Circles']],
  ['xmlns\'s namespace as the default, of an element within', '<Circles xmlns="' + C1 + '"><Circle xmlns="' + XMLNS_NAMESPACE + '"/></Circles>', ['reserved xmlns on Circle', 'not ignorable Circle']],
  ['an element\'s name with the prefix xmlns, within', '<Circles xmlns="' + C1 + '"><xmlns:Circle/></Circles>', ['reserved prefix of xmlns:Circle']],
  ['a prefix undeclared, within', '<Circles xmlns="' + C1 + '" xmlns:p="' + C1 + '"><Circle xmlns:p=""/></Circles>', ['undeclared xmlns:p on Circle']],
  ['an element\'s prefix that nothing binds, within', '<Circles xmlns="' + C1 + '"><p:Circle/></Circles>', ['unbound p:Circle']],
  ['an attribute\'s prefix that nothing binds', '<Circles xmlns="' + C1 + '" p:Radius="1"/>', ['unbound p:Radius on Circles']],
  ['a prefix that nothing binds, within an element a consumer ignores',
    '<Circles xmlns="' + C1 + '" xmlns:mc="' + MARKUP_COMPATIBILITY + '" xmlns:x="urn:x" mc:Ignorable="x"><x:ignored><p:Circle/></x:ignored></Circles>', ['unbound p:Circle']],
  ['two attributes of one expanded name, under two prefixes',
    '<Circles xmlns="' + C1 + '" xmlns:p="' + C1 + '" xmlns:q="' + C1 + '" p:Radius="1" q:Radius="2"/>', ['repeated q:Radius on Circles']],
  ['an element\'s name of two colons, within', '<Circles xmlns="' + C1 + '" xmlns:p="' + C1 + '"><p:Circle:x/></Circles>', ['not a name p:Circle:x']],
  ['an element\'s name of an empty prefix, within', '<Circles xmlns="' + C1 + '"><:Circle/></Circles>', ['not a name :Circle']],
  ['an attribute\'s name of two colons', '<Circles xmlns="' + C1 + '" xmlns:p="' + C1 + '" p:Radius:x="1"/>', ['not a name p:Radius:x on Circles']],
  ['a declaration of a prefix with a colon', '<Circles xmlns="' + C1 + '" xmlns:p:q="' + C1 + '"/>', ['not a name xmlns:p:q on Circles']],
  ['a declaration of an empty prefix', '<Circles xmlns:="' + C1 + '"/>', ['not a name xmlns: on Circles']],
  ['an element\'s local name that starts with a combining mark, which an NCName doesn\'t, though XML\'s name after a colon may, within',
    '<Circles xmlns="' + C1 + '" xmlns:p="' + C1 + '"><p:\u0300Circle/></Circles>', ['not a name p:\u0300Circle']],
  ['an attribute\'s local name that starts with a middle dot, which goes on an NCName but doesn\'t start one',
    '<Circles xmlns="' + C1 + '" xmlns:p="' + C1 + '" p:\u00B7Radius="1"/>', ['not a name p:\u00B7Radius on Circles']],
];

describe('the markup compatibility check', () => {
  // Each document with each consumer, and what the consumer rejects it
  // for, each by hand from the rules of ECMA-376 Part 3: first the
  // standard's own examples, whose outcome it gives, then cases of its rules
  it.each([
    ['the Ignorable attribute\'s example, whose attributes of later versions each consumer ignores or reads',
      ROOT + ' mc:Ignorable="v2 v3" mc:PreserveAttributes="v3:Luminance">' + circle('0,0', 'Blue', ' v2:Opacity="0.5" v3:Luminance="13"') + circle('25,0', 'Black', ' v2:Opacity="0.5" v3:Luminance="13"') + '</Circles>',
      [[V1, []], [V2, []], [V3, []]]],
    ['the Ignorable attribute\'s example of one ignorable namespace under two prefixes, which a consumer ignores both of',
      '<Circles xmlns="' + C1 + '" xmlns:mc="' + MARKUP_COMPATIBILITY + '" xmlns:a="http://schemas.openxmlformats.org/MyExtension/v1" xmlns:b="http://schemas.openxmlformats.org/MyExtension/v1" mc:Ignorable="a"><a:IgnoreMe/><b:IgnoreMeToo/></Circles>',
      [[V1, []]]],
    ['that example with its prefixes apart by a tab written as a reference, which is white space in the list as a tab is',
      ROOT + ' mc:Ignorable="v2&#9;v3" mc:PreserveAttributes="v3:Luminance">' + circle('0,0', 'Blue', ' v2:Opacity="0.5" v3:Luminance="13"') + '</Circles>',
      [[V1, []], [V2, []], [V3, []]]],
    ['the MustUnderstand attribute\'s note, whose later version\'s attribute, not ignorable, a Version 1 consumer rejects at its element',
      ROOT + '>' + circle('0,0', 'Blue') + circle('38,0', 'Green', ' v2:Opacity="0.5"') + '</Circles>',
      [[V1, ['not ignorable v2:Opacity on Circle']], [V2, []]]],
    ['the MustUnderstand attribute\'s example, which a Version 1 consumer rejects at the root',
      ROOT + ' mc:MustUnderstand="v2">' + circle('0,0', 'Blue') + circle('38,0', 'Green', ' v2:Opacity="0.5"') + '</Circles>',
      [[V1, ['not understood v2 in mc:MustUnderstand on Circles', 'not ignorable v2:Opacity on Circle']], [V2, []]]],
    ['the ProcessContent attribute\'s example, whose watermark a Version 1 consumer ignores, with its circles, and whose blink it ignores but not its circles',
      ROOT + ' mc:Ignorable="v2" mc:ProcessContent="v2:Blink"><v2:Watermark Opacity="v0.1">' + circle('0,0', 'Blue') + '</v2:Watermark><v2:Blink>' + circle('13,0', 'Yellow') + '</v2:Blink></Circles>',
      [[V1, []], [V2, []]]],
    ['that example with a Version 3 element, not ignorable, in each of the two, which a Version 1 consumer reads only in the blink',
      ROOT + ' mc:Ignorable="v2" mc:ProcessContent="v2:Blink"><v2:Watermark><v3:Halo/></v2:Watermark><v2:Blink><v3:Halo/></v2:Blink></Circles>',
      [[V1, ['not ignorable v3:Halo']], [V3, []]]],
    ['the alternate content example, whose choice only a Version 3 consumer reads, and whose fallback, with an ignorable Version 2 attribute, the others read',
      ROOT + ' mc:Ignorable="v2 v3"><mc:AlternateContent><mc:Choice Requires="v3"><v3:Circle Center="0,0" Radius="20" Color="Blue" Opacity="0.5" Luminance="13"/></mc:Choice>'
        + '<mc:Fallback><LuminanceFilter Luminance="13">' + circle('0,0', 'Blue', ' v2:Opacity="0.5"') + '</LuminanceFilter></mc:Fallback></mc:AlternateContent></Circles>',
      [[V1, []], [V2, []], [V3, []]]],
    ['that example without the Ignorable attribute, whose fallback\'s Version 2 attribute a Version 1 consumer rejects',
      ROOT + '><mc:AlternateContent><mc:Choice Requires="v3"><v3:Circle/></mc:Choice><mc:Fallback>' + circle('0,0', 'Blue', ' v2:Opacity="0.5"') + '</mc:Fallback></mc:AlternateContent></Circles>',
      [[V1, ['not ignorable v2:Opacity on Circle']], [V3, []]]],
    // A consumer reads one branch of alternatives, the first choice whose
    // Requires names only namespaces it understands, or else the fallback,
    // and skips the others, whatever they hold (§10.2)
    ['that example with a Version 2 attribute, not ignorable, in its choice, which only a Version 3 consumer reads',
      ROOT + '><mc:AlternateContent><mc:Choice Requires="v3"><v3:Circle v2:Opacity="0.5"/></mc:Choice><mc:Fallback>' + circle('0,0', 'Blue') + '</mc:Fallback></mc:AlternateContent></Circles>',
      [[V1, []], [V2, []], [V3, []]]],
    ['that example with a choice for Version 2 after the one for Version 3, each holding what an earlier version doesn\'t understand, not ignorable, which each consumer reads only in its own',
      ROOT + '><mc:AlternateContent><mc:Choice Requires="v3"><v3:Circle/></mc:Choice><mc:Choice Requires="v2">' + circle('0,0', 'Blue', ' v2:Opacity="0.5" v3:Luminance="13"') + '</mc:Choice>'
        + '<mc:Fallback>' + circle('0,0', 'Blue', ' v2:Opacity="0.5"') + '</mc:Fallback></mc:AlternateContent></Circles>',
      [[V1, ['not ignorable v2:Opacity on Circle']], [V2, ['not ignorable v3:Luminance on Circle']], [V3, []]]],
    // A consumer that reads a choice understands what it requires, so an
    // element of that namespace there is itself, though mc:ProcessContent
    // names it, with attributes that must be ignorable or understood
    ['a choice for Version 2 holding the blink, which mc:ProcessContent names, with a Version 3 attribute that isn\'t ignorable',
      ROOT + ' mc:Ignorable="v2" mc:ProcessContent="v2:Blink"><mc:AlternateContent><mc:Choice Requires="v2"><v2:Blink v3:Luminance="13">' + circle('0,0', 'Blue') + '</v2:Blink></mc:Choice>'
        + '<mc:Fallback>' + circle('0,0', 'Blue') + '</mc:Fallback></mc:AlternateContent></Circles>',
      [[V1, []], [V2, ['not ignorable v3:Luminance on v2:Blink']], [V3, []]]],
    // It reads the Requires of each choice up to the one it reads, a prefix
    // there that nothing binds too, but not of those after it
    ['a choice whose Requires names a prefix that nothing binds, after a choice for Version 2',
      ROOT + '><mc:AlternateContent><mc:Choice Requires="v2">' + circle('0,0', 'Blue', ' v2:Opacity="0.5"') + '</mc:Choice><mc:Choice Requires="p"/><mc:Fallback/></mc:AlternateContent></Circles>',
      [[V1, ['unbound p in Requires on mc:Choice']], [V2, []]]],
    // A consumer reads a choice only where it understands what the choice
    // requires, so the choice's own mc:MustUnderstand of it is met
    ['a choice whose own MustUnderstand names what it requires',
      ROOT + '><mc:AlternateContent><mc:Choice Requires="v3" mc:MustUnderstand="v3"><v3:Circle/></mc:Choice><mc:Fallback/></mc:AlternateContent></Circles>',
      [[V1, []], [V3, []]]],
    // An extension's content, which the application that knows its uri
    // reads, not markup compatibility ([MS-OEXTXML])
    ['DrawingML\'s extension list, whose extension holds another namespace, not ignorable',
      '<a:graphic xmlns:a="' + DRAWINGML + '"><a:extLst><a:ext uri="urn:x"><x:payload xmlns:x="urn:x"/></a:ext></a:extLst></a:graphic>',
      [[new Set([DRAWINGML]), []]]],
    // Namespaces in XML 1.0, which a reader must report (§8), so isn't read
    // (see NAMESPACE_RULES, above)
    ...NAMESPACE_RULES.map(([description, xml]) => [description, xml, [[V1, ['not well-formed']]]]),
    ['xml declared, as it may be, to xml\'s namespace, and the default undeclared', '<Circles xmlns="' + C1 + '" xmlns:xml="' + XML_NAMESPACE + '"><Circle xmlns=""/></Circles>', [[V1, []]]],
    // XML 1.0 §2.1: a document has one root element
    ['two root elements', '<Circles xmlns="' + C1 + '"/><Circles xmlns="' + C1 + '"/>', [[V1, ['not well-formed']]]],
  ] as Array<[string, string, Array<[ReadonlySet<string>, string[]]>]>)('finds, as markup compatibility has it, what each consumer rejects in %s', (_, xml, outcomes) => {
    for (const [consumer, problems] of outcomes) expect(documentCompatibilityProblems(xml, consumer)).toEqual(problems);
  });

  // In nodes it's given, which parseOrdered didn't read, as export builds
  it.each(NAMESPACE_RULES)('names, in nodes, %s', (_, xml, problems) => {
    const nodes = xmlParser(ORDERED_OPTIONS).parse(xml) as XmlNode[];
    expect(compatibilityProblems(nodes, { scope: new Map(), compatibility: NO_COMPATIBILITY }, V1)).toEqual(problems);
  });
});
