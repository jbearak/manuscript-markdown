// The line ends markdown-it reads, which its core's normalize rule turns
// into \n before it reads any block: a \r\n, a \r alone or a \n. Its regex,
// NEWLINES_RE in markdown-it/lib/rules_core/normalize.mjs, isn't exported,
// so this is a copy of it.
const NEWLINES_RE = /\r\n?|\n/g;

/** `text` with each line end markdown-it reads as \n, as it reads it. Each
 *  step before markdown-it, on export and in the preview, reads the text
 *  after this, so it splits lines where markdown-it does. Line numbers stay
 *  the same, as each line end is one */
export function normalizeNewlines(text: string): string {
  return text.includes('\r') ? text.replace(NEWLINES_RE, '\n') : text;
}
