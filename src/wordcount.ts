import * as vscode from 'vscode';

/**
 * Calculates the number of words in a given text string.
 * 
 * Words are defined as sequences of non-whitespace characters separated by
 * whitespace boundaries (spaces, tabs, newlines). Consecutive whitespace
 * characters are treated as a single separator. Leading and trailing
 * whitespace is excluded from the count.
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
  // Strip YAML frontmatter (--- delimited block at start of document)
  const stripped = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const trimmed = stripped.trim();

  if (trimmed === "") {
    return 0;
  }

  return trimmed.split(/\s+/).length;
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

/**
 * Controller class that manages the word count status bar item.
 * 
 * This class is responsible for:
 * - Creating and configuring the status bar item
 * - Registering event listeners for editor, selection, and document changes
 * - Updating the status bar display based on current editor state
 * - Cleaning up resources on disposal
 */
export class WordCountController {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private static readonly DEBOUNCE_MS = 500;

  constructor() {
        // Create status bar item with left alignment and priority 100
        this.statusBarItem = vscode.window.createStatusBarItem(
          vscode.StatusBarAlignment.Left,
          100
        );

        // Initialize disposables array
        this.disposables = [];

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

        // Register onDidChangeTextDocument listener (debounced)
        this.disposables.push(
          vscode.workspace.onDidChangeTextDocument(() => {
            this.scheduleUpdate();
          })
        );

        // Perform initial update to set correct state
        this.updateWordCount();
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

    // Calculate word count based on selection state
    let text: string;

    // Check if all selections are empty (zero-length)
    const allSelectionsEmpty = selections.every(selection => selection.isEmpty);

    if (allSelectionsEmpty) {
      // Use entire document text when no text is selected
      text = editor.document.getText();
    } else {
      // Concatenate all selected text with spaces
      const selectedTexts = selections.map(selection =>
        editor.document.getText(selection)
      );
      text = selectedTexts.join(' ');
    }

    // Calculate word count
    const wordCount = countWords(text);

    // Format status bar text as "$(book) N Words"
    this.statusBarItem.text = `$(book) ${wordCount} words`;

    // Show status bar item
    this.statusBarItem.show();
  }
}
