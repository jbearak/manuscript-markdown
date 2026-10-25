// src/tracked-math.ts — how Word records a tracked change to an equation,
// written by export and read back by import.
//
// Word tracks an equation's runs and its structures apart. A run's change is
// a w:ins or w:del around the run, or, as Word itself saves it, inside the
// run around its properties and text. A structure, as the accent of \hat{x}
// or a fraction, is changed only where its m:ctrlPr holds a w:ins or w:del.
// Word reads a change around a structure, or around a whole m:oMath, for
// the runs in it alone: without a mark of its own, the structure stays where
// Word removes the change, as an accent over an empty box, and a mark inside
// a change around the equation ends that change for Word, which then shows
// the rest of a deleted equation as kept. So export writes each change to an
// equation as Word does (see pushedMathChanges), and import reads what Word
// writes back as one change around what it holds (see normalizeTrackedMath).

import { pushAll } from './arrays';
import { asXmlNodes, type XmlAttributes, type XmlNode } from './omml';

/** Equation structures, each of whose properties (`<name>Pr`) can end in an
 *  m:ctrlPr that marks the structure as in a change */
const STRUCTURES: ReadonlySet<string> = new Set(['m:f', 'm:sSup', 'm:sSub', 'm:sSubSup', 'm:sPre', 'm:rad', 'm:nary', 'm:d', 'm:acc',
  'm:m', 'm:func', 'm:eqArr', 'm:borderBox', 'm:limLow', 'm:limUpp', 'm:bar', 'm:groupChr', 'm:box', 'm:phant']);

/** What holds an equation's runs and structures in turn: an equation, a
 *  display equation's paragraph, a structure's parts and a matrix's rows */
const MATH_CONTAINERS: ReadonlySet<string> = new Set(['m:oMathPara', 'm:oMath', 'm:e', 'm:num', 'm:den', 'm:sub', 'm:sup', 'm:deg',
  'm:lim', 'm:fName', 'm:mr']);

/** The run properties of a structure's mark, which the schema requires, in
 *  math's font, as Word writes them; an empty w:rPr Word would drop */
const MARK_RPR = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** An element of XML export writes: its name, its attributes as written,
 *  and its content, or none where it's an empty tag */
interface Element { name: string; attrs: string; children: Piece[] | null }
type Piece = Element | string;

/** The elements and text of `xml`, which export wrote, so is well formed,
 *  with no comment, CDATA or processing instruction */
function parseFragment(xml: string): Piece[] {
  const root: Element = { name: '', attrs: '', children: [] };
  const open: Element[] = [root];
  for (const [token, closing, name, attrs, empty] of xml.matchAll(/<(\/?)([\w:.-]+)((?:\s[^>]*?)?)(\/?)>|[^<]+/g)) {
    const parent = open[open.length - 1];
    if (name === undefined) parent.children!.push(token);
    else if (closing) open.pop();
    else {
      const element: Element = { name, attrs, children: empty ? null : [] };
      parent.children!.push(element);
      if (!empty) open.push(element);
    }
  }
  return root.children!;
}

function serialize(pieces: Piece[]): string {
  return pieces.map(piece => typeof piece === 'string' ? piece
    : '<' + piece.name + piece.attrs + (piece.children ? '>' + serialize(piece.children) + '</' + piece.name + '>' : '/>')).join('');
}

const isChange = (piece: Piece): piece is Element =>
  typeof piece !== 'string' && (piece.name === 'w:ins' || piece.name === 'w:del') && piece.children !== null;

/** Whether `pieces` hold a structure of an equation, past a structure's
 *  m:ctrlPr, whose change is the structure's mark */
function holdsStructure(pieces: Piece[]): boolean {
  return pieces.some(piece => typeof piece !== 'string' && piece.name !== 'm:ctrlPr' &&
    (STRUCTURES.has(piece.name) || holdsStructure(piece.children ?? [])));
}

/**
 * `xml` with each tracked change that holds a structure of an equation as
 * Word writes it (see the file's header): the change around each run of
 * the equation's, consecutive runs in one, and on each structure, in its
 * m:ctrlPr, and around neither the equation nor the structure. The first
 * change keeps the w:id of the one it replaces, and `id` gives the others
 * theirs. A change around runs alone, as of text, in an equation or around
 * one of runs alone, stays as it is, which Word reads as it is written, and
 * import tells apart: {++$x$++} from ${++x++}$. One that holds a structure
 * import reads back around the equation where it is around all its content
 * (see normalizeTrackedMath), as Word can't tell the two apart. A structure
 * marked already keeps its mark, as one in a change in an equation in a
 * deletion: Word holds one change on it.
 */
export function pushedMathChanges(xml: string, id: () => number): string {
  if (!xml.includes('<m:')) return xml;
  return serialize(walk(parseFragment(xml), id));
}

function walk(pieces: Piece[], id: () => number): Piece[] {
  return pieces.flatMap((piece): Piece[] => {
    if (typeof piece === 'string' || !piece.children) return [piece];
    if (isChange(piece) && holdsStructure(piece.children)) return pushed(piece.children, piece, { first: true }, id);
    return [{ ...piece, children: walk(piece.children, id) }];
  });
}

/** `pieces`, which `change` held, with it on each of their runs and
 *  structures in turn (see pushedMathChanges) */
function pushed(pieces: Piece[], change: Element, state: { first: boolean; inParagraph?: boolean }, id: () => number): Piece[] {
  const out: Piece[] = [];
  let group: Piece[] = [];
  const flush = () => {
    if (group.some(piece => typeof piece !== 'string' || piece.trim())) {
      const attrs = state.first ? change.attrs : withId(change.attrs, id());
      state.first = false;
      out.push({ name: change.name, attrs, children: group });
    } else {
      pushAll(out, group);
    }
    group = [];
  };
  for (const piece of pieces) {
    const name = typeof piece === 'string' || !piece.children ? '' : piece.name;
    const inner = name === 'w:ins' || name === 'w:del';
    // An equation of runs alone stays whole in the change, as it would alone,
    // but not one of a display paragraph's, which import reads only where
    // it's the paragraph's own (see normalizeTrackedMath)
    const whole = (name === 'm:oMathPara' || (name === 'm:oMath' && !state.inParagraph)) && !holdsStructure((piece as Element).children!);
    if (whole || (!inner && !MATH_CONTAINERS.has(name) && !STRUCTURES.has(name))) {
      group.push(piece);
      continue;
    }
    const element = piece as Element;
    flush();
    // A change in the change, as an equation's in a deletion of it, holds
    // its own runs
    if (inner) pushAll(out, walk([element], id));
    else if (name === 'm:oMathPara') {
      state.inParagraph = true;
      out.push({ ...element, children: pushed(element.children!, change, state, id) });
      state.inParagraph = false;
    } else if (MATH_CONTAINERS.has(name)) out.push({ ...element, children: pushed(element.children!, change, state, id) });
    else out.push(markedStructure(element, change, state, id));
  }
  flush();
  return out;
}

/** `structure` with `change` as its mark, unless it has one, and on the
 *  runs and structures of its parts */
function markedStructure(structure: Element, change: Element, state: { first: boolean; inParagraph?: boolean }, id: () => number): Element {
  const propsName = structure.name + 'Pr';
  const children = structure.children!;
  const props = children.find((piece): piece is Element => typeof piece !== 'string' && piece.name === propsName);
  const ctrlPr = props?.children?.find((piece): piece is Element => typeof piece !== 'string' && piece.name === 'm:ctrlPr');
  const parts = children.filter(piece => piece !== props).map(piece =>
    typeof piece !== 'string' && piece.children && MATH_CONTAINERS.has(piece.name) ? { ...piece, children: pushed(piece.children, change, state, id) } : piece);
  if (ctrlPr?.children?.some(isChange)) return { ...structure, children: [props!, ...parts] };
  // The control's own run properties stay in the mark, where it had them
  const rPr = ctrlPr?.children?.find((piece): piece is Element => typeof piece !== 'string' && piece.name === 'w:rPr');
  const mark: Element = {
    name: 'm:ctrlPr', attrs: '',
    children: [{ name: change.name, attrs: withId(change.attrs, id()), children: rPr ? [rPr] : parseFragment(MARK_RPR) }],
  };
  // m:ctrlPr is the last of every structure's properties
  const others = (props?.children ?? []).filter(piece => piece !== ctrlPr);
  return { ...structure, children: [{ name: propsName, attrs: props?.attrs ?? '', children: [...others, mark] }, ...parts] };
}

function withId(attrs: string, id: number): string {
  return / w:id="[^"]*"/.test(attrs) ? attrs.replace(/ w:id="[^"]*"/, () => ' w:id="' + id + '"') : ' w:id="' + id + '"' + attrs;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** A node's element name */
const tagOf = (node: XmlNode): string => Object.keys(node).find(key => key !== ':@') ?? '';

/** A tracked change's kind, author and date, which a change of the same
 *  edit shares, whatever its w:id */
interface Change { tag: string; author: string; date: string; attrs: XmlAttributes }

function changeOf(node: XmlNode): Change | undefined {
  const tag = tagOf(node);
  if (tag !== 'w:ins' && tag !== 'w:del') return undefined;
  const attrs = node[':@'] ?? {};
  return { tag, author: attrs['@_w:author'] ?? '', date: attrs['@_w:date'] ?? '', attrs };
}

const sameChange = (a: Change | undefined, b: Change | undefined): boolean =>
  !!a && !!b && a.tag === b.tag && a.author === b.author && a.date === b.date;

const changeNode = (change: Change, children: XmlNode[]): XmlNode => ({ [change.tag]: children, ':@': change.attrs });

const isBlank = (node: XmlNode): boolean => tagOf(node) === '#text' && !String(node['#text']).trim();

/**
 * `nodes`, a part of a document as the parser reads it, with each
 * equation's tracked changes as import reads them (see the file's header):
 * a change Word writes in a run around the run, a structure whose mark (see
 * pushedMathChanges) and runs are all in one change in that change, and
 * adjacent pieces of one change, as Word writes one of several runs, in
 * one. An equation all in one change that holds a structure is in that
 * change, as a w:del around the m:oMath, or the m:oMathPara of a display
 * equation, which import reads as CriticMarkup around the equation, where
 * export wrote one of runs alone (see pushedMathChanges). Without this, import wrote a deleted
 * \hat{x} as \hat{{--x--}}, which keeps the accent where the deletion is
 * accepted, and Word's change in a run, as nothing.
 */
export function normalizeTrackedMath(nodes: XmlNode[]): XmlNode[] {
  return nodes.flatMap((node): XmlNode[] => {
    const tag = tagOf(node);
    if (tag === '#text' || tag === '') return [node];
    const children = asXmlNodes(node[tag]);
    if (tag === 'm:oMath') {
      const math = { ...node, [tag]: mathChildren(children) };
      const whole = wholeChange(math);
      return whole ? [changeNode(whole.change, [{ ...node, [tag]: whole.children }])] : [math];
    }
    if (tag === 'm:oMathPara') {
      // Its equations in one change only where all of them are, each whole,
      // as import reads only the paragraph's own m:oMath: one in a change of
      // its own, beside another, would go unread
      // An equation in a change, as the schema allows there, as one whose
      // content is in it
      const unwrapped = children.flatMap((child): XmlNode[] => {
        const change = changeOf(child);
        const held = change ? asXmlNodes(child[change.tag]) : [];
        if (!change || !held.some(n => tagOf(n) === 'm:oMath') || !held.every(n => isBlank(n) || tagOf(n) === 'm:oMath')) return [child];
        return held.map(n => isBlank(n) ? n : { ...n, 'm:oMath': [changeNode(change, asXmlNodes(n['m:oMath']))] });
      });
      const inner = unwrapped.map(child => tagOf(child) === 'm:oMath' ? { ...child, 'm:oMath': mathChildren(asXmlNodes(child['m:oMath'])) } : child);
      const equations = inner.filter(child => tagOf(child) === 'm:oMath');
      const wholes = equations.map(math => wholeChange(math, false));
      const change = wholes[0]?.change;
      if (change && wholes.every(whole => sameChange(whole?.change, change)) && wholes.some(whole => whole!.children.some(holdsStructureNode))) {
        return [changeNode(change, [{ ...node, [tag]: inner.map(child => {
          const at = equations.indexOf(child);
          return at === -1 ? child : { ...child, 'm:oMath': wholes[at]!.children };
        }) }])];
      }
      return [{ ...node, [tag]: inner }];
    }
    return [{ ...node, [tag]: normalizeTrackedMath(children) }];
  });
}

/** The change all of an equation's content is in, and that content out of
 *  it, or undefined where its content is not all in one, or, where
 *  `structured`, holds no structure (see pushedMathChanges) */
function wholeChange(math: XmlNode, structured = true): { change: Change; children: XmlNode[] } | undefined {
  const content = asXmlNodes(math['m:oMath']).filter(child => !isBlank(child));
  const change = content.length === 1 ? changeOf(content[0]) : undefined;
  const children = change && asXmlNodes(content[0][change.tag]);
  return change && (!structured || children!.some(holdsStructureNode)) ? { change, children: children! } : undefined;
}

/** Whether `node` is or holds a structure of an equation */
function holdsStructureNode(node: XmlNode): boolean {
  const tag = tagOf(node);
  return STRUCTURES.has(tag) || (tag !== '#text' && tag !== '' && asXmlNodes(node[tag]).some(holdsStructureNode));
}

/** An equation's or a part's `children` read as described at
 *  normalizeTrackedMath */
function mathChildren(children: XmlNode[]): XmlNode[] {
  const pieces = children.flatMap((child): XmlNode[] => {
    const tag = tagOf(child);
    const inner = tag === '#text' ? [] : asXmlNodes(child[tag]);
    if (tag === 'm:r') return runChanges(child, inner);
    const change = changeOf(child);
    if (change) {
      // What's in it, in a change of the same edit, is in it alone
      return [changeNode(change, mathChildren(inner).flatMap(n => sameChange(changeOf(n), change) ? asXmlNodes(n[change.tag]) : [n]))];
    }
    if (STRUCTURES.has(tag)) return [trackedStructure(child, tag, inner)];
    if (MATH_CONTAINERS.has(tag)) return [{ ...child, [tag]: mathChildren(inner) }];
    return [child];
  });
  // Adjacent pieces of one change, past white space between them, in one
  const merged: XmlNode[] = [];
  for (const piece of pieces) {
    const change = changeOf(piece);
    let at = merged.length - 1;
    while (at >= 0 && isBlank(merged[at])) at--;
    const previous = at >= 0 ? changeOf(merged[at]) : undefined;
    if (change && sameChange(previous, change)) {
      merged[at] = changeNode(previous!, [...asXmlNodes(merged[at][previous!.tag]), ...merged.splice(at + 1), ...asXmlNodes(piece[change.tag])]);
    } else {
      merged.push(piece);
    }
  }
  return merged;
}

/** A run whose content Word holds in changes, as it saves a change to a
 *  run, `<m:r><w:del><w:rPr/><m:t>x</m:t></w:del></m:r>`, as a run in each
 *  of them, and one of any text in none, each with the run's properties */
function runChanges(run: XmlNode, inner: XmlNode[]): XmlNode[] {
  if (!inner.some(child => changeOf(child))) return [run];
  const props = inner.filter(child => tagOf(child) === 'm:rPr' || tagOf(child) === 'w:rPr');
  const runOf = (content: XmlNode[]): XmlNode => {
    // The change's own w:rPr is the run's, where it has one
    const own = new Set(content.map(tagOf));
    return { ...run, 'm:r': [...props.filter(p => !own.has(tagOf(p))), ...content] };
  };
  const out: XmlNode[] = [];
  let plain: XmlNode[] = [];
  const flush = () => {
    if (plain.some(child => !isBlank(child))) out.push(runOf(plain));
    plain = [];
  };
  for (const child of inner) {
    if (props.includes(child)) continue;
    const change = changeOf(child);
    if (!change) {
      plain.push(child);
      continue;
    }
    flush();
    const content = asXmlNodes(child[change.tag]);
    // Properties first, as a run holds them
    content.sort((a, b) => Number(!['m:rPr', 'w:rPr'].includes(tagOf(a))) - Number(!['m:rPr', 'w:rPr'].includes(tagOf(b))));
    out.push(changeNode(change, [runOf(content)]));
  }
  flush();
  return out;
}

/** `structure` with its parts read as at normalizeTrackedMath, and in the
 *  change its mark is of, with its mark and the change on its parts' runs
 *  out of it, where all of its runs are in that change */
function trackedStructure(structure: XmlNode, tag: string, inner: XmlNode[]): XmlNode {
  const parts = inner.map(child => {
    const childTag = tagOf(child);
    return MATH_CONTAINERS.has(childTag) ? { ...child, [childTag]: mathChildren(asXmlNodes(child[childTag])) } : child;
  });
  const props = parts.find(child => tagOf(child) === tag + 'Pr');
  const ctrlPr = props && asXmlNodes(props[tag + 'Pr']).find(child => tagOf(child) === 'm:ctrlPr');
  const markNode = ctrlPr && asXmlNodes(ctrlPr['m:ctrlPr']).find(child => changeOf(child));
  const mark = markNode && changeOf(markNode);
  const rest = parts.filter(child => child !== props);
  if (!mark || !rest.every(child => allIn(child, mark))) return { ...structure, [tag]: parts };
  const unmarkedCtrlPr = { ...ctrlPr, 'm:ctrlPr': asXmlNodes(ctrlPr!['m:ctrlPr']).flatMap(child => child === markNode ? asXmlNodes(child[mark.tag]) : [child]) };
  const unmarkedProps = { ...props, [tag + 'Pr']: asXmlNodes(props![tag + 'Pr']).map(child => child === ctrlPr ? unmarkedCtrlPr : child) };
  return changeNode(mark, [{ ...structure, [tag]: [unmarkedProps, ...rest.map(child => outOf(child, mark))] }]);
}

/** Whether every run of text and structure in `node` is in a change of the
 *  same edit as `change`, past properties, whose mark is a structure's own */
function allIn(node: XmlNode, change: Change): boolean {
  const tag = tagOf(node);
  if (tag === '#text') return !String(node['#text']).trim();
  if (changeOf(node)) return sameChange(changeOf(node), change);
  if (tag === 'm:r') return !asXmlNodes(node[tag]).some(child => tagOf(child) === 'm:t' && extractText(asXmlNodes(child['m:t'])) !== '');
  if (tag.endsWith('Pr')) return true;
  // A structure in it is in the change where it's marked so, which wraps it
  // in the change already (see trackedStructure), and isn't, empty or not,
  // where it isn't
  if (STRUCTURES.has(tag)) return false;
  return asXmlNodes(node[tag]).every(child => allIn(child, change));
}

/** `node` with each change of the same edit as `change` in it out of it */
function outOf(node: XmlNode, change: Change): XmlNode {
  const tag = tagOf(node);
  if (tag === '#text' || tag.endsWith('Pr')) return node;
  return {
    ...node,
    [tag]: asXmlNodes(node[tag]).flatMap(child => sameChange(changeOf(child), change) ? asXmlNodes(child[change.tag]) : [outOf(child, change)]),
  };
}

function extractText(nodes: XmlNode[]): string {
  return nodes.map(node => node['#text'] !== undefined ? String(node['#text']) : '').join('');
}
