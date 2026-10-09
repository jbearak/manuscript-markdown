// The fences of a custom style block, which export (top level and list
// items), import's checks of what export reads as a directive, and the
// preview all read with this one function, so they agree on what a fence is.

/** A comment that is a style block's fence: an opening one, a closing one,
 *  or a block on one line, with its text between its fences */
export type StyleFence =
  | { kind: 'open'; style: string }
  | { kind: 'close' }
  | { kind: 'inline'; style: string; content: string };

// A style's name holds no -->, which ends the comment it is in, so the
// opening fence of a block on one line can't read as one with the rest of
// the line in the name
const NAME = '((?:(?!-->).)+?)';
const INLINE_RE = new RegExp('^<!--\\s*style:\\s*' + NAME + '\\s*-->([\\s\\S]*?)<!--\\s*\\/style\\s*-->$', 'i');
const OPEN_RE = new RegExp('^<!--\\s*style:\\s*' + NAME + '\\s*-->$', 'i');
const CLOSE_RE = /^<!--\s*\/style\s*-->$/i;

/** What fence of a style block `comment` is, with the space around it
 *  ignored, or undefined if none */
export function styleFence(comment: string): StyleFence | undefined {
  const text = comment.trim();
  const inline = INLINE_RE.exec(text);
  if (inline) return { kind: 'inline', style: inline[1], content: inline[2] };
  const open = OPEN_RE.exec(text);
  if (open) return { kind: 'open', style: open[1] };
  return CLOSE_RE.test(text) ? { kind: 'close' } : undefined;
}
