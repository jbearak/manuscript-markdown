// Test support: what in XML breaks the rules of markup compatibility
// (ECMA-376 Part 3) for a consumer that understands a set of namespaces,
// Word's by default (see WORD_UNDERSTOOD_NAMESPACES), so that a test can
// check every element and attribute export writes, wherever it goes. Not
// part of the extension.

import { COMPATIBILITY_LISTS, MARKUP_COMPATIBILITY, NO_COMPATIBILITY, WORD_UNDERSTOOD_NAMESPACES, XML_NAMESPACE, attributesOf, childrenOf, contextIn, expandName, holdsExtension, isElement, isNamed, namespaceOfPrefix, namespaceProblems, nameOf, parseOrdered, scopeIn, type Context, type Scope, type XmlNode } from './scoped-xml';
import { pushAll } from './arrays';

/**
 * What breaks the rules in nodes, in a context, for a consumer that
 * understands `understood`, each as a line that names it: first what
 * breaks the rules of Namespaces in XML anywhere in them (see
 * namespaceProblems), which nodes parseOrdered reads have none of; then a
 * prefix of a token in markup compatibility's lists of prefixes that
 * nothing binds where it is; a token of
 * mc:ProcessContent, mc:PreserveElements or mc:PreserveAttributes whose
 * namespace isn't ignorable where it is; a token of mc:MustUnderstand
 * whose namespace the consumer doesn't understand, ignorable or not; and
 * an element or attribute in a namespace the consumer doesn't understand
 * that isn't ignorable where it is. Either makes it reject the document,
 * unless a choice that requires the namespace holds it, or is it. An
 * ignorable element of a namespace it doesn't understand it discards, with
 * its attributes and what it holds, whose markup compatibility isn't
 * checked, but where mc:ProcessContent names it, a wrapper whose content it
 * reads, whose is. Nor is that of what an extension holds, an ext in an extLst of a namespace the
 * consumer understands, which the application that knows the extension
 * reads, not markup compatibility ([MS-OEXTXML]), as resolvedNode leaves
 * it (see holdsExtension). Nor, of markup
 * compatibility's alternatives, that of the branches the consumer skips,
 * all but the one it reads (ECMA-376 Part 3 §10.2), though it reads the
 * Requires of each choice up to that one, a prefix there that nothing
 * binds too.
 */
export function compatibilityProblems(nodes: XmlNode[], context: Context, understood: ReadonlySet<string> = WORD_UNDERSTOOD_NAMESPACES): string[] {
  const problems = namespaceProblems(nodes, context.scope);
  /** Whether the consumer understands a namespace, markup compatibility's
   *  and xml's too, or what a choice that holds a name, or is its element,
   *  requires, which it reads only where it does: the one test of
   *  understanding here */
  const knows = (namespace: string, required: ReadonlySet<string>) =>
    understood.has(namespace) || namespace === MARKUP_COMPATIBILITY || namespace === XML_NAMESPACE || required.has(namespace);
  /** The prefixes a choice in a scope requires, each with its namespace
   *  there, and a line for each that nothing binds */
  const requirementsOf = (choice: XmlNode, scope: Scope) => {
    const prefixes = (attributesOf(choice, scope).find(attribute => attribute.namespace === undefined && attribute.local === 'Requires')?.value ?? '').split(/\s+/).filter(Boolean);
    const namespaces = prefixes.map(prefix => namespaceOfPrefix(prefix, scopeIn(choice, scope)));
    return { namespaces, unbound: prefixes.filter((_, i) => namespaces[i] === undefined).map(prefix => 'unbound ' + prefix + ' in Requires on ' + nameOf(choice)) };
  };
  /** Of the branches of alternatives in a scope inside them, those the
   *  consumer skips: of the choices and fallback, all but the first
   *  choice whose Requires names only namespaces it understands, or else
   *  the fallback (ECMA-376 Part 3 §10.2), as chosenBranch has it for
   *  Word. It reads the Requires of each choice up to that one. */
  const skippedOf = (branches: XmlNode[], scope: Scope, required: ReadonlySet<string>) => {
    const skipped = new Set<XmlNode>();
    let chosen = false;
    for (const branch of branches) {
      const isChoice = isNamed(branch, scope, MARKUP_COMPATIBILITY, 'Choice');
      if (!isChoice && !isNamed(branch, scope, MARKUP_COMPATIBILITY, 'Fallback')) continue;
      if (chosen) {
        skipped.add(branch);
        continue;
      }
      if (!isChoice) {
        chosen = true;
        continue;
      }
      const { namespaces, unbound } = requirementsOf(branch, scope);
      chosen = namespaces.length > 0 && namespaces.every(namespace => namespace !== undefined && knows(namespace, required));
      if (!chosen) {
        pushAll(problems, unbound);
        skipped.add(branch);
      }
    }
    return skipped;
  };
  const walk = (node: XmlNode, outer: Context, outside: ReadonlySet<string>, parent?: { namespace: string | undefined; local: string }) => {
    if (!isElement(node)) return;
    const inner = contextIn(node, outer);
    const name = nameOf(node);
    const own = expandName(name, inner.scope);
    // What a choice requires, which a consumer that reads it, its
    // attributes too, understands
    let required = outside;
    if (isNamed(node, outer.scope, MARKUP_COMPATIBILITY, 'Choice')) {
      const { namespaces, unbound } = requirementsOf(node, outer.scope);
      pushAll(problems, unbound);
      required = new Set([...outside, ...namespaces.filter((namespace): namespace is string => namespace !== undefined)]);
    }
    // Whether the consumer discards it, and whether it reads its content
    // all the same, as a wrapper's
    const discarded = own.namespace !== undefined && !knows(own.namespace, required) && inner.compatibility.ignorable.has(own.namespace);
    const wrapper = discarded && (inner.compatibility.processContent.has(own.namespace + ' ' + own.local) || inner.compatibility.processContent.has(own.namespace + ' *'));
    if (own.namespace !== undefined && !discarded && !knows(own.namespace, required)) problems.push('not ignorable ' + name);
    for (const attribute of attributesOf(node, outer.scope)) {
      const qname = attribute.key.slice('@_'.length);
      if (qname.includes(':') && attribute.namespace === undefined) continue;
      // Its attributes go with it, but a wrapper's markup compatibility
      // settings, which say how to read its content
      if (discarded && !(wrapper && attribute.namespace === MARKUP_COMPATIBILITY)) continue;
      if (attribute.namespace !== undefined && !knows(attribute.namespace, required) && !inner.compatibility.ignorable.has(attribute.namespace)) problems.push('not ignorable ' + qname + ' on ' + name);
      // Markup compatibility's lists, each of which needs what it names
      // ignorable or understood where it is
      const list = attribute.namespace === MARKUP_COMPATIBILITY ? COMPATIBILITY_LISTS.find(list => list.local === attribute.local) : undefined;
      if (!list) continue;
      for (const token of attribute.value.split(/\s+/).filter(Boolean)) {
        const prefix = token.includes(':') ? token.slice(0, token.indexOf(':')) : token;
        const namespace = namespaceOfPrefix(prefix, inner.scope);
        if (namespace === undefined) problems.push('unbound ' + token + ' in ' + qname + ' on ' + name);
        else if (list.needs === 'ignorable' && !inner.compatibility.ignorable.has(namespace)) problems.push('not ignorable ' + token + ' in ' + qname + ' on ' + name);
        else if (list.needs === 'understood' && !knows(namespace, required)) problems.push('not understood ' + token + ' in ' + qname + ' on ' + name);
      }
    }
    if (discarded && !wrapper || !Array.isArray(node[name])) return;
    // What an extension holds
    if (holdsExtension(own, parent, namespace => knows(namespace, required))) return;
    // Of alternatives, the branch it reads, not those it skips
    const children = childrenOf(node);
    const skipped = isNamed(node, outer.scope, MARKUP_COMPATIBILITY, 'AlternateContent') ? skippedOf(children, inner.scope, required) : new Set<XmlNode>();
    for (const child of children) if (!skipped.has(child)) walk(child, inner, required, own);
  };
  for (const node of nodes) walk(node, context, new Set());
  return problems;
}

/** What breaks the rules in an XML document, from its root, or ['not
 *  well-formed'] where it isn't, or isn't namespace-well-formed, which
 *  parseOrdered doesn't read, with nothing bound outside the root, or
 *  hasn't one root element (XML 1.0 §2.1), which it allows, reading parts
 *  of a document too */
export function documentCompatibilityProblems(xml: string, understood?: ReadonlySet<string>): string[] {
  const nodes = parseOrdered(xml, new Map());
  return nodes && nodes.filter(isElement).length === 1
    ? compatibilityProblems(nodes, { scope: new Map(), compatibility: NO_COMPATIBILITY }, understood) : ['not well-formed'];
}
