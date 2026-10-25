import * as vscode from 'vscode';
import { criticSpanStarts } from './critic-markup';
import { type CriticSpan, criticSpanAt } from './inline-syntax';
import { isEscapedAt } from './math-delimiters';
import { normalizeNewlines } from './newlines';

// The count as written reads each character once and allocates nothing, as
// the status bar counts the whole document again after each edit: the
// split(/\s+/) it was counted with made an array of every word. The count
// with changes accepted reads no CriticMarkup of its own: the spans are
// those preprocessing reads for the preview and Word export (see
// criticSpanStarts), each read with criticSpanAt (see inline-syntax.ts), and
// a text with no opener costs one more regex test.

const FRONTMATTER_RE = /^---[ \t]*\r?\n(?![ \t]*\r?\n)[\s\S]*?\r?\n---[ \t]*(?=\r?\n|$)\r?\n?/;

/** Where the text after a YAML frontmatter block at the start of `text` starts, or 0 */
function bodyStart(text: string): number {
  if (text.charCodeAt(0) !== 0x2D /* - */) return 0;
  const match = FRONTMATTER_RE.exec(text);
  return match ? match[0].length : 0;
}

/** Whether `c` is a character /\s/ matches */
function isSpace(c: number): boolean {
  if (c <= 0x20) return c === 0x20 || (c >= 0x09 && c <= 0x0D);
  if (c < 0xA0) return false;
  return c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x2028
    || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
}

/** A count of words over pieces of text read in order, as if joined: a word
 *  that runs to a piece's end goes on into the next, as foo{--x--}bar is
 *  one word once the deletion is accepted */
interface Tally { words: number; inWord: boolean }

function tally(text: string, from: number, to: number, t: Tally): void {
  let { words, inWord } = t;
  for (let i = from; i < to; i++) {
    if (isSpace(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; words++; }
  }
  t.words = words;
  t.inWord = inWord;
}

/**
 * Calculates the number of words in a given text string.
 *
 * Words are defined as sequences of non-whitespace characters separated by
 * whitespace boundaries (spaces, tabs, newlines). Consecutive whitespace
 * characters are treated as a single separator. Leading and trailing
 * whitespace is excluded from the count. A YAML frontmatter block at the
 * start is left out.
 *
 * @param text - The text string to count words in
 * @returns The number of words in the text
 *
 * @example
 * countWords("hello world") // returns 2
 * countWords("hello  world") // returns 2 (multiple spaces)
 * countWords("  hello  ") // returns 1 (leading/trailing whitespace ignored)
 * countWords("") // returns 0
 * countWords("hello-world") // returns 1 (hyphenated words count as one)
 */
export function countWords(text: string): number {
  const t: Tally = { words: 0, inWord: false };
  tally(text, bodyStart(text), text.length, t);
  return t.words;
}

/** The markdown's state for criticSpanAt, one for the whole count, as its
 *  closer search is made once for each state (see criticCloserSearchOf):
 *  a span's text is read with posMax at its end */
type SpanState = { src: string; posMax: number };

/** Tally the words of `span` as they read with it accepted */
function tallySpan(state: SpanState, span: CriticSpan, t: Tally): void {
  if (span.kind === 'range_start' || span.kind === 'range_end') return;
  const text = state.src;
  // An opener at a line's end starts a new paragraph, as preprocessing moves
  // it to one (see moveLeadingBreakOutsideCritic in critic-markup.ts), but
  // for a span of the line end alone
  const opener = span.kind === 'comment' && span.id !== undefined ? -1 : text.charCodeAt(span.contentStart);
  if (opener === 0x0A /* \n */ && text.slice(span.contentStart, span.contentEnd).trim() !== '') {
    t.inWord = false;
  }
  switch (span.kind) {
    case 'addition':
    case 'highlight':
      tallySpanText(state, span.contentStart, span.contentEnd, t);
      break;
    case 'substitution':
      tallySpanText(state, span.separator + 2, span.contentEnd, t);
      break;
    // A deletion and a comment leave no words
  }
}

/** The starts of the runs of backticks from `from` to `to`, by their length */
function backtickRuns(text: string, from: number, to: number): Map<number, number[]> {
  const runs = new Map<number, number[]>();
  for (let i = text.indexOf('`', from); i !== -1 && i < to; i = text.indexOf('`', i)) {
    const start = i;
    while (i < to && text.charCodeAt(i) === 0x60 /* ` */) i++;
    const at = runs.get(i - start);
    if (at) at.push(start);
    else runs.set(i - start, [start]);
  }
  return runs;
}

/** The first of `starts`, in order, at or after `from`, or -1 */
function firstFrom(starts: readonly number[] | undefined, from: number): number {
  if (!starts) return -1;
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < starts.length ? starts[lo] : -1;
}

/** Tally the words of a span's text from `from` to `to`, read on its own, as
 *  the preview reads it: a code span closed in it, or a { after a
 *  backslash, is text, and the CriticMarkup in it is read as in a span */
function tallySpanText(state: SpanState, from: number, to: number, t: Tally): void {
  const text = state.src;
  let runs: Map<number, number[]> | undefined;
  let pos = from;
  let i = from;
  while (i < to) {
    const c = text.charCodeAt(i);
    if (c === 0x60 /* ` */) {
      let open = i;
      while (i < to && text.charCodeAt(i) === 0x60) i++;
      if (isEscapedAt(text, open)) open++;
      if (open === i) continue;
      // Its closer: the next run of as many backticks, which runs finds
      // once for the text, as markdown-it's backtick rule does
      runs ??= backtickRuns(text, from, to);
      const close = firstFrom(runs.get(i - open), i);
      if (close !== -1) i = close + (i - open);
      continue;
    }
    if (c === 0x7B /* { */ && !isEscapedAt(text, i)) {
      state.posMax = to;
      const span = criticSpanAt(state, i);
      if (span && span.kind !== 'range_start' && span.kind !== 'range_end') {
        tally(text, pos, i, t);
        tallySpan(state, span, t);
        pos = i = span.end;
        continue;
      }
    }
    i++;
  }
  tally(text, pos, to, t);
}

/**
 * The number of words in `text` as countWords counts them once every change
 * in it is accepted: an addition's text and a substitution's new text in,
 * a deletion's and a substitution's old text out, and comments out too, as
 * Word leaves them out of its count. The spans are those preprocessing
 * reads for the preview and Word export (see criticSpanStarts), so
 * CriticMarkup in code, an HTML block or an equation, or after a
 * backslash, is text. A comment's range's markers are, as where they are
 * written.
 *
 * The inline parse that follows preprocessing reads a span on one line
 * differently in two places, which only a parse of the whole document,
 * at 7 times the cost, would match: a span in raw HTML in a paragraph, as
 * in a <!-- comment -->, which is text there, is read here as a change, and
 * one after a backtick that pairs with another past a span or a blank
 * line, which is a change there, is read here as code.
 */
export function countAcceptedWords(text: string): number {
  const from = bodyStart(text);
  let body = from > 0 ? text.slice(from) : text;
  // Preprocessing reads \n line ends alone; a \r\n is as much a space
  body = normalizeNewlines(body);
  const t: Tally = { words: 0, inWord: false };
  const state: SpanState = { src: body, posMax: body.length };
  let pos = 0;
  for (const start of criticSpanStarts(body)) {
    state.posMax = body.length;
    const span = criticSpanAt(state, start);
    if (!span || start < pos) continue;
    tally(body, pos, start, t);
    tallySpan(state, span, t);
    pos = span.end;
  }
  tally(body, pos, body.length, t);
  return t.words;
}

/**
 * Checks if the given document is a text document (markdown or plaintext).
 *
 * This function determines whether a document should display word count information
 * based on its language ID. Only markdown and plaintext documents are considered
 * text documents for word counting purposes.
 *
 * @param document - An object with a languageId property
 * @returns true if the document's languageId is "markdown" or "plaintext", false otherwise
 *
 * @example
 * isTextDocument({ languageId: "markdown" }) // returns true
 * isTextDocument({ languageId: "plaintext" }) // returns true
 * isTextDocument({ languageId: "typescript" }) // returns false
 */
export function isTextDocument(document: { languageId: string }): boolean {
  return document.languageId === "markdown" || document.languageId === "plaintext";
}

/** The status bar item's command, which turns counting with changes accepted on or off */
export const TOGGLE_ACCEPTED_WORD_COUNT_COMMAND = 'manuscript-markdown.toggleWordCountAcceptChanges';
const ACCEPT_CHANGES_SETTING = 'wordCount.acceptChanges';

/**
 * The status bar item's text for `words`, counted with changes accepted
 * or not.
 */
export function wordCountText(words: number, acceptChanges: boolean): string {
  return '$(book) ' + words + (acceptChanges ? ' words (accepted)' : ' words');
}

/**
 * Controller class that manages the word count status bar item.
 *
 * This class is responsible for:
 * - Creating and configuring the status bar item
 * - Registering event listeners for editor, selection, and document changes
 * - Updating the status bar display based on current editor state
 * - Cleaning up resources on disposal
 *
 * The whole document's count is kept for its version, so moving the cursor
 * reads none of its text again.
 */
export class WordCountController {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private acceptChanges: boolean;
  private documentCount: { document: vscode.TextDocument; version: number; acceptChanges: boolean; words: number } | undefined;
  private static readonly DEBOUNCE_MS = 500;

  constructor() {
        // Create status bar item with left alignment and priority 100
        this.statusBarItem = vscode.window.createStatusBarItem(
          vscode.StatusBarAlignment.Left,
          100
        );
        this.statusBarItem.command = TOGGLE_ACCEPTED_WORD_COUNT_COMMAND;
        this.acceptChanges = WordCountController.readAcceptChanges();

        // Initialize disposables array
        this.disposables = [];

        this.disposables.push(
          vscode.commands.registerCommand(TOGGLE_ACCEPTED_WORD_COUNT_COMMAND, () => this.toggleAcceptChanges())
        );

        this.disposables.push(
          vscode.workspace.onDidChangeConfiguration(e => {
            if (!e.affectsConfiguration('manuscriptMarkdown.' + ACCEPT_CHANGES_SETTING)) return;
            this.acceptChanges = WordCountController.readAcceptChanges();
            this.updateWordCount();
          })
        );

        // Register onDidChangeActiveTextEditor listener
        this.disposables.push(
          vscode.window.onDidChangeActiveTextEditor(() => {
            this.updateWordCount();
          })
        );

        // Register onDidChangeTextEditorSelection listener (debounced)
        this.disposables.push(
          vscode.window.onDidChangeTextEditorSelection(() => {
            this.scheduleUpdate();
          })
        );

        // Register onDidChangeTextDocument listener (debounced), for the
        // shown document alone, as output channels change often
        this.disposables.push(
          vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document === vscode.window.activeTextEditor?.document) this.scheduleUpdate();
          })
        );

        // Perform initial update to set correct state
        this.updateWordCount();
      }

  private static readAcceptChanges(): boolean {
    return vscode.workspace.getConfiguration('manuscriptMarkdown').get<boolean>(ACCEPT_CHANGES_SETTING, false);
  }

  /** Turn counting with changes accepted on or off, in the workspace's
   *  settings where they set it, as the preview's markup toggle does */
  private async toggleAcceptChanges(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('manuscriptMarkdown');
    const target = cfg.inspect(ACCEPT_CHANGES_SETTING)?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await cfg.update(ACCEPT_CHANGES_SETTING, !this.acceptChanges, target);
  }

  /**
   * Schedules a debounced word count update.
   * Cancels any existing pending timer and sets a new one.
   */
  private scheduleUpdate(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.updateWordCount();
    }, WordCountController.DEBOUNCE_MS);
  }


  /**
   * Disposes all resources used by the controller.
   */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.documentCount = undefined;
    this.statusBarItem.dispose();
    this.disposables.forEach(d => { d.dispose(); });
  }
  /**
   * Checks if the given document is a text document (markdown or plaintext).
   *
   * @param document - The document to check
   * @returns true if the document is markdown or plaintext, false otherwise
   */
  private isTextDocument(document: vscode.TextDocument): boolean {
    return isTextDocument(document);
  }

  private count(text: string): number {
    return this.acceptChanges ? countAcceptedWords(text) : countWords(text);
  }

  /** The whole document's count, kept for its version */
  private countDocument(document: vscode.TextDocument): number {
    const kept = this.documentCount;
    if (kept && kept.document === document && kept.version === document.version && kept.acceptChanges === this.acceptChanges) {
      return kept.words;
    }
    const words = this.count(document.getText());
    this.documentCount = { document, version: document.version, acceptChanges: this.acceptChanges, words };
    return words;
  }

  /**
   * Updates the word count display based on the current editor state.
   *
   * This method:
   * - Gets the active text editor
   * - Checks if the document is a text document (markdown or plaintext)
   * - Hides the status bar if not applicable
   * - Calculates word count based on selection state
   * - Updates and shows the status bar item
   */
  private updateWordCount(): void {
    // Get active text editor
    const editor = vscode.window.activeTextEditor;

    // Check if editor exists and document is text document
    if (!editor || !this.isTextDocument(editor.document)) {
      // Hide status bar if not applicable
      this.statusBarItem.hide();
      return;
    }

    // Get selections from editor
    const selections = editor.selections;

    // Use the entire document when no text is selected, else all selected
    // text joined with spaces
    const wordCount = selections.every(selection => selection.isEmpty)
      ? this.countDocument(editor.document)
      : this.count(selections.map(selection => editor.document.getText(selection)).join(' '));

    this.statusBarItem.text = wordCountText(wordCount, this.acceptChanges);
    this.statusBarItem.tooltip = this.acceptChanges
      ? 'Words with every change accepted and comments left out. Click to count the text as written.'
      : 'Words as written. Click to count them with every change accepted.';

    // Show status bar item
    this.statusBarItem.show();
  }
}
