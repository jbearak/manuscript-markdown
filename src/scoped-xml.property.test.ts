import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import { compatibilityProblems, documentCompatibilityProblems } from './markup-compatibility-check';
import { EXPORT_CONTEXT, MARKUP_COMPATIBILITY, NO_COMPATIBILITY, WORDPROCESSINGML, WORD_UNDERSTOOD_NAMESPACES, XML_NAMESPACE, attributesOf, canonical, childrenOf, contextIn, effectiveSectPr, expandName, expandedNameOf,
  XML_NAME_CHARACTERS, XML_NAME_START_CHARACTERS, isElement, isNamed, mapProperties, moved, nameOf, parseOrdered, scopeIn, type Context, type Scope, type XmlNode } from './scoped-xml';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const STRICT = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const X = 'urn:example:x', Y = 'urn:example:y';

// XML 1.0's characters of names (§2.3), each range from its first to its
// last: those a name starts with, a colon too, which Namespaces in XML
// doesn't allow in an NCName, and those it goes on with
const NAME_STARTS = XML_NAME_START_CHARACTERS, NAME_CHARS = XML_NAME_CHARACTERS;
const within = (ranges: ReadonlyArray<readonly [number, number]>, c: number) => ranges.some(([first, last]) => c >= first && c <= last);
/** Whether text is an NCName: a name of those characters but a colon */
const isNCName = (text: string) => {
  const points = [...text].map(c => c.codePointAt(0)!);
  return points.length > 0 && !points.includes(0x3A) && within(NAME_STARTS, points[0]) && points.every(c => within(NAME_CHARS, c));
};
/** Whether text is a QName: an NCName, or two with a colon between */
const isQName = (text: string) => text.split(':').length <= 2 && text.split(':').every(isNCName);
/** Characters at the edges of those ranges, in them and just outside,
 *  but surrogates, which are no characters alone */
const EDGES = [...new Set(NAME_CHARS.flatMap(([first, last]) => [first - 1, first, last, last + 1]))]
  .filter(c => c >= 0x21 && c <= 0x10FFFF && (c < 0xD800 || c > 0xDFFF));

/** A section's properties in a part, with the declarations and markup
 *  compatibility's settings of what's around them, from parts of the
 *  section tests' templates: WordprocessingML's properties, Transitional's
 *  or Strict's, under w or another prefix, with an extension's attributes
 *  and mc:MustUnderstand; extensions' elements, with text; wrappers;
 *  alternatives, in a choice or fallback too, which, as wrappers, can
 *  have markup compatibility's lists of their own; a tracked change; prefixes
 *  the sectPr binds otherwise; and markup compatibility's lists that name
 *  WordprocessingML's namespace, which can be ignorable too, and in
 *  mc:MustUnderstand namespaces Word understands or doesn't */
const templateSectPr = fc.record({
  p: fc.constantFrom(W, STRICT),
  w: fc.constantFrom(W, STRICT, X),
  x: fc.constantFrom(X, Y),
  y: fc.constantFrom(Y, W14),
  mc: fc.constantFrom('mc', 'm'),
  ignorable: fc.subarray(['x', 'y', 'p']),
  processContent: fc.subarray(['x:wrap', 'y:wrap', 'x:*', 'p:wrap']),
  own: fc.constantFrom('', ' xmlns:x="' + Y + '"', ' {mc}:Ignorable="x"', ' {mc}:ProcessContent="x:wrap"', ' xmlns:w="' + X + '" {mc}:Ignorable="w"', ' {mc}:PreserveAttributes="x:hint y:*"',
    ' {mc}:ProcessContent="p:wrap"', ' {mc}:MustUnderstand="x"', ' {mc}:MustUnderstand="y"', ' {mc}:MustUnderstand="p w14"'),
}).chain(around => {
  const wml = ['p', ...(around.w !== X ? ['w'] : [])];
  const others = ['x', 'y', ...(around.w !== X ? [] : ['w'])];
  const mc = around.mc;
  // Markup compatibility's lists on a wrapper or a choice, which its
  // content keeps where it's flattened
  const lists = fc.constantFrom('', ' ' + mc + ':PreserveAttributes="x:hint"', ' ' + mc + ':PreserveElements="y:ext x:*"', ' ' + mc + ':Ignorable="y"');
  const { children } = fc.letrec<{ children: string; child: string }>(tie => ({
    children: fc.array(tie('child'), { maxLength: 4 }).map(list => list.join('')),
    child: fc.oneof({ depthSize: 'small', withCrossShrink: true },
      fc.tuple(fc.constantFrom(...wml), fc.constantFrom('pgSz', 'pgMar', 'cols', 'docGrid', 'titlePg', 'type', 'pgNumType'), fc.option(fc.constantFrom(...others)), fc.option(fc.constantFrom('w14', ...others)))
        .map(([p, name, e, must]) => '<' + p + ':' + name + ' ' + p + ':val="1"' + (e ? ' ' + e + ':hint="1"' : '') + (must ? ' ' + mc + ':MustUnderstand="' + must + '"' : '') + '/>'),
      // An extension's element, empty, with text, or holding a property
      // under a prefix of WordprocessingML's, which Word ignores with it
      // where it's ignorable and not a wrapper
      fc.tuple(fc.constantFrom(...others), fc.constantFrom('', 'payload', ...wml.map(q => '<' + q + ':pgSz ' + q + ':w="2"/>')))
        .map(([e, inner]) => '<' + e + ':ext' + (inner ? '>' + inner + '</' + e + ':ext>' : '/>')),
      fc.tuple(fc.constantFrom(...others), lists, tie('children')).map(([e, list, inner]) => '<' + e + ':wrap' + list + '>' + inner + '</' + e + ':wrap>'),
      // Alternatives: a choice, which can hold a wrapper of the namespace it
      // requires, which a consumer that reads it understands, maybe a second
      // choice, and a fallback
      fc.tuple(fc.constantFrom('w14', ...others), lists, tie('children'), fc.boolean(), fc.option(fc.tuple(fc.constantFrom('w14', ...others), tie('children'))), tie('children'))
        .map(([required, list, choice, wrapped, second, fallback]) => '<' + mc + ':AlternateContent><' + mc + ':Choice Requires="' + required + '"' + list + '>'
          + (wrapped && required !== 'w14' ? '<' + required + ':wrap>' + choice + '</' + required + ':wrap>' : choice) + '</' + mc + ':Choice>'
          + (second ? '<' + mc + ':Choice Requires="' + second[0] + '">' + second[1] + '</' + mc + ':Choice>' : '')
          + '<' + mc + ':Fallback>' + fallback + '</' + mc + ':Fallback></' + mc + ':AlternateContent>'),
      fc.constant('text'),
      fc.tuple(fc.constantFrom(...wml), tie('children')).map(([p, inner]) => '<' + p + ':sectPrChange ' + p + ':id="1"><' + p + ':sectPr>' + inner + '</' + p + ':sectPr></' + p + ':sectPrChange>'),
    ),
  }));
  return fc.tuple(fc.constantFrom(...wml), children).map(([p, inner]) => {
    const declarations = ' xmlns:p="' + around.p + '" xmlns:w="' + around.w + '" xmlns:x="' + around.x + '" xmlns:y="' + around.y + '" xmlns:w14="' + W14 + '" xmlns:' + mc + '="' + MARKUP_COMPATIBILITY + '"'
      + (around.ignorable.length ? ' ' + mc + ':Ignorable="' + around.ignorable.join(' ') + '"' : '')
      + (around.processContent.length ? ' ' + mc + ':ProcessContent="' + around.processContent.join(' ') + '"' : '');
    return '<root' + declarations + '><' + p + ':sectPr' + around.own.split('{mc}').join(mc) + '>' + inner + '</' + p + ':sectPr></root>';
  });
});

describe('names that parseOrdered reads', () => {
  /** Whether parseOrdered reads a name as XML does, of an element, an
   *  attribute and a prefix declared */
  const readsAsXml = (name: string) => {
    const prefix = name.includes(':') ? name.slice(0, name.indexOf(':')) : undefined;
    const declaration = prefix === undefined ? ' xmlns="' + X + '"' : ' xmlns:' + prefix + '="' + X + '"';
    return (parseOrdered('<' + name + declaration + '/>', new Map()) !== undefined) === isQName(name)
      && (parseOrdered('<a' + declaration + ' ' + name + '="1"/>', new Map()) !== undefined) === isQName(name)
      && (parseOrdered('<' + name + ':a xmlns:' + name + '="' + X + '"/>', new Map()) !== undefined) === isNCName(name);
  };

  it('are QNames, each of one or two characters at the edges of XML\'s name characters', () => {
    // Bun 1.3.9's regular expressions read some pairs, as U+F8FF U+FDCF,
    // as one character past U+FFFF, so the name check, a regular
    // expression's, took eleven of them for names
    const names = EDGES.flatMap(first => [String.fromCodePoint(first), ...EDGES.map(second => String.fromCodePoint(first, second))]);
    expect(names.filter(name => !readsAsXml(name)).map(name => [...name].map(c => c.codePointAt(0)!.toString(16)).join(' '))).toEqual([]);
  });

  // Of characters at the edges of XML's name characters, with colons
  it('are QNames, of an element, an attribute or a prefix declared, of XML\'s name characters', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...EDGES), { minLength: 1, maxLength: 5 }).map(points => points.map(c => String.fromCodePoint(c)).join('')), name => {
      const prefix = name.includes(':') ? name.slice(0, name.indexOf(':')) : undefined;
      const declaration = prefix === undefined ? ' xmlns="' + X + '"' : ' xmlns:' + prefix + '="' + X + '"';
      expect(parseOrdered('<' + name + declaration + '/>', new Map()) !== undefined).toBe(isQName(name));
      expect(parseOrdered('<a' + declaration + ' ' + name + '="1"/>', new Map()) !== undefined).toBe(isQName(name));
      expect(parseOrdered('<' + name + ':a xmlns:' + name + '="' + X + '"/>', new Map()) !== undefined).toBe(isNCName(name));
    }), { numRuns: 500 });
  });

  // Two names that differ in one character past U+FFFF, or in that and one
  // of the first a validator could be given in its place
  it('are kept apart where they differ only in a character past U+FFFF', () => {
    const astral = fc.oneof(fc.constantFrom(0x10000, 0x10001, 0xEFFFE, 0xEFFFF), fc.integer({ min: 0x10000, max: 0xEFFFF }));
    const other = fc.oneof(astral, fc.constantFrom(0x3400, 0x3401, 0x3402));
    fc.assert(fc.property(astral, other, fc.constantFrom('', 'a', 'p:'), (first, second, start) => {
      fc.pre(first !== second);
      const [one, two] = [first, second].map(c => start + String.fromCodePoint(c));
      const declared = start === 'p:' ? ' xmlns:p="' + X + '"' : '';
      expect(parseOrdered('<r' + declared + ' ' + one + '="1" ' + two + '="2"/>', new Map())).toBeDefined();
      expect(parseOrdered('<' + one + declared + '></' + two + '>', new Map())).toBeUndefined();
      expect(parseOrdered('<' + one + declared + '></' + one + '>', new Map())).toBeDefined();
    }), { numRuns: 300 });
  });
});

describe('section properties read and moved under markup compatibility', () => {
  it('break none of its rules, as Word reads them in export\'s document, where the template breaks none but in naming in mc:MustUnderstand what Word doesn\'t understand', () => {
    // Which makes Word reject the template, and which the sectPr as Word
    // reads it in export's document leaves out (see withMustUnderstandMet)
    const unmet = (problem: string) => problem.startsWith('not understood ');
    fc.assert(fc.property(templateSectPr, xml => {
      fc.pre(documentCompatibilityProblems(xml).every(unmet));
      const [root] = parseOrdered(xml)!.filter(isElement);
      const around = contextIn(root, { scope: new Map(), compatibility: NO_COMPATIBILITY });
      const sectPr = childrenOf(root).find(isElement)!;
      // A sectPr, which a prefix it binds otherwise can make another's
      fc.pre(isNamed(sectPr, around.scope, WORDPROCESSINGML, 'sectPr'));
      // Under export's prefixes, as the template has it, and as Word reads
      // it, and each of its properties as a reader takes it into another
      // section
      expect(compatibilityProblems([canonical(sectPr, around)], EXPORT_CONTEXT).filter(problem => !unmet(problem))).toEqual([]);
      const effective = effectiveSectPr(sectPr, around);
      expect(compatibilityProblems([effective], EXPORT_CONTEXT)).toEqual([]);
      const inside = contextIn(effective, EXPORT_CONTEXT);
      expect(compatibilityProblems(childrenOf(effective).map(node => moved(node, inside, EXPORT_CONTEXT)), EXPORT_CONTEXT)).toEqual([]);
      // Its children as Word reads them, by expanded name
      const context = contextIn(sectPr, around);
      expect(childrenOf(effective).filter(isElement).map(node => expandedNameOf(node, inside.scope)))
        .toEqual(read(childrenOf(sectPr), context, new Set(), true).map(node => expandedNameOf(node.node, node.scope)));
      // And the shared walk visits the properties each consumer reads, in
      // each branch, each whole
      const visited: XmlNode[] = [];
      mapProperties(childrenOf(sectPr), context, node => {
        visited.push(node);
        return [node];
      });
      expect(visited).toEqual(read(childrenOf(sectPr), context, new Set(), false).map(({ node }) => node));
    }), { numRuns: 300 });
  });
});

/**
 * The elements among a sectPr's children, `nodes`, in a context, that a
 * consumer reads as its children, each with the scope it's in: of
 * alternatives, those in the branch Word reads, `asWord`, the first choice
 * whose Requires names only namespaces Word understands, or else the
 * fallback, or in each branch, for every consumer; and of a wrapper whose
 * content the consumer reads, an ignorable element mc:ProcessContent names
 * of a namespace it doesn't understand, what it holds. A consumer that
 * reads a choice understands what the choice requires, `required`. The
 * test's own reading, from ECMA-376 Part 3 §10.1.2 and §10.2.
 */
function read(nodes: XmlNode[], context: Context, required: ReadonlySet<string>, asWord: boolean): Array<{ node: XmlNode; scope: Scope }> {
  return nodes.filter(isElement).flatMap(node => {
    const inner = contextIn(node, context);
    if (isNamed(node, context.scope, MARKUP_COMPATIBILITY, 'AlternateContent')) {
      const branches = childrenOf(node).filter(isElement).flatMap(branch => {
        const choice = isNamed(branch, inner.scope, MARKUP_COMPATIBILITY, 'Choice');
        if (!choice && !isNamed(branch, inner.scope, MARKUP_COMPATIBILITY, 'Fallback')) return [];
        const scope = scopeIn(branch, inner.scope);
        const requires = choice ? (attributesOf(branch, inner.scope).find(({ namespace, local }) => namespace === undefined && local === 'Requires')?.value ?? '').split(/\s+/).filter(Boolean)
          .map(prefix => prefix === 'xml' ? XML_NAMESPACE : scope.get(prefix)) : [];
        return [{ branch, choice, requires }];
      });
      const word = branches.find(({ choice, requires }) => !choice || requires.length > 0 && requires.every(namespace => namespace !== undefined && WORD_UNDERSTOOD_NAMESPACES.has(namespace)));
      return (asWord ? (word ? [word] : []) : branches).flatMap(({ branch, requires }) =>
        read(childrenOf(branch), contextIn(branch, inner), new Set([...required, ...requires.filter((namespace): namespace is string => namespace !== undefined)]), asWord));
    }
    const { namespace, local } = expandName(nameOf(node), inner.scope);
    const wrapper = namespace !== undefined && !WORD_UNDERSTOOD_NAMESPACES.has(namespace) && !required.has(namespace) && inner.compatibility.ignorable.has(namespace)
      && (inner.compatibility.processContent.has(namespace + ' ' + local) || inner.compatibility.processContent.has(namespace + ' *'));
    return wrapper ? read(childrenOf(node), inner, required, asWord) : [{ node, scope: context.scope }];
  });
}
