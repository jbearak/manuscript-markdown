# Design Document: Word Count Status Bar

## Overview

This design document describes the implementation of a word count status bar item for the mdmarkup VS Code extension. The feature will display real-time word count information in the VS Code status bar, showing either the word count of selected text or the entire document. The implementation follows VS Code extension best practices and integrates cleanly with the existing mdmarkup architecture.

The word count feature will be implemented as a separate module (`src/wordcount.ts`) that manages a status bar item, listens to editor events, and updates the display based on the active editor and selection state.

## Architecture

The word count feature consists of three main components:

1. **WordCountController**: A class that manages the lifecycle of the status bar item and coordinates event handling
2. **Word Count Calculator**: A pure function that calculates word counts from text strings
3. **Event Handlers**: Listeners for editor changes, selection changes, and document changes

The architecture follows the existing pattern established in the mdmarkup extension where features are implemented in separate modules and registered during extension activation.

```
┌─────────────────────────────────────────────────────────────┐
│                      extension.ts                            │
│  (Activation: creates WordCountController instance)          │
└────────────────────────┬────────────────────────────────────┘
                         │
                         │ creates & manages
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                  WordCountController                         │
│  - Manages StatusBarItem lifecycle                           │
│  - Registers event listeners                                 │
│  - Coordinates updates                                       │
└────────┬────────────────────────────────┬───────────────────┘
         │                                │
         │ uses                           │ listens to
         ▼                                ▼
┌──────────────────────┐      ┌─────────────────────────────┐
│  countWords()        │      │   VS Code Events            │
│  - Pure function     │      │   - onDidChangeTextEditor   │
│  - Calculates count  │      │   - onDidChangeSelection    │
│                      │      │   - onDidChangeTextDocument │
└──────────────────────┘      └─────────────────────────────┘
         │
         │ updates
         ▼
┌──────────────────────────────────────────────────────────────┐
│                    VS Code StatusBarItem                      │
│  - Displays "$(book) N words"                                │
│  - Positioned in left section                                │
└──────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### WordCountController Class

The `WordCountController` class manages the status bar item and handles all event coordination.

**TypeScript Interface:**
```typescript
class WordCountController {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[];

  constructor();
  
  // Updates the status bar based on current editor state
  private updateWordCount(): void;
  
  // Checks if the given document should show word count
  private isTextDocument(document: vscode.TextDocument): boolean;
  
  // Disposes all resources
  dispose(): void;
}
```

**Responsibilities:**
- Create and configure the status bar item during construction
- Register event listeners for editor, selection, and document changes
- Determine when to show/hide the status bar item based on document type
- Calculate and update the displayed word count
- Clean up resources on disposal

**Key Methods:**

`constructor()`: 
- Creates a status bar item with alignment `Left` and priority `100`
- Registers event listeners using `vscode.window.onDidChangeActiveTextEditor`, `vscode.window.onDidChangeTextEditorSelection`, and `vscode.workspace.onDidChangeTextDocument`
- Performs initial update to set correct state
- Stores all disposables for cleanup

`updateWordCount()`:
- Gets the active text editor
- Checks if the document is a text document (markdown or plaintext)
- If not a text document or no editor, hides the status bar item
- If text document, gets the selection(s) and calculates word count
- Updates the status bar item text with the calculated count
- Shows the status bar item

`isTextDocument(document)`:
- Returns `true` if `document.languageId` is "markdown" or "plaintext"
- Returns `false` otherwise

`dispose()`:
- Disposes the status bar item
- Disposes all registered event listeners

### Word Count Calculator

A pure function that calculates the number of words in a given text string.

**TypeScript Interface:**
```typescript
function countWords(text: string): number;
```

**Algorithm:**
1. Trim leading and trailing whitespace from the input text
2. If the trimmed text is empty, return 0
3. Split the text on whitespace boundaries using regex `/\s+/`
4. Return the length of the resulting array

**Examples:**
- `countWords("")` → `0`
- `countWords("   ")` → `0`
- `countWords("hello")` → `1`
- `countWords("hello world")` → `2`
- `countWords("hello  world")` → `2` (multiple spaces treated as one separator)
- `countWords("hello\nworld")` → `2` (newlines are whitespace)
- `countWords("hello-world")` → `1` (hyphenated words count as one)
- `countWords("test123")` → `1` (words with numbers count as one)

### Event Handling

The controller registers three event listeners:

**1. onDidChangeActiveTextEditor**
- Triggered when the user switches between editor tabs
- Calls `updateWordCount()` to refresh the display for the new editor

**2. onDidChangeTextEditorSelection**
- Triggered when the user changes the text selection
- Calls `updateWordCount()` to show the word count of the new selection

**3. onDidChangeTextDocument**
- Triggered when the document content changes (typing, deletion, etc.)
- Calls `updateWordCount()` to reflect the new document word count

All event listeners are stored in the `disposables` array for proper cleanup.

## Data Models

### StatusBarItem Configuration

The status bar item is configured with the following properties:

```typescript
{
  alignment: vscode.StatusBarAlignment.Left,
  priority: 100,
  text: "$(book) N words",  // N is the calculated word count
  tooltip: undefined,        // No tooltip needed
  command: undefined         // No command on click
}
```

### Text Selection Model

When calculating word count for selections:

```typescript
interface SelectionInfo {
  selections: vscode.Selection[];  // Array of selections (can be multiple)
  document: vscode.TextDocument;   // The document containing the selections
}
```

**Selection Logic:**
- If all selections are empty (zero-length), use the entire document text
- If any selection has non-zero length, concatenate all selected text with spaces
- Calculate word count on the resulting text

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*


### Property 1: Status bar text format

*For any* non-negative integer word count value, the status bar text should be formatted as "$(book) N Words" where N is the word count value.

**Validates: Requirements 1.4**

### Property 2: Text document detection

*For any* document, the isTextDocument function should return true if and only if the document's languageId is "markdown" or "plaintext".

**Validates: Requirements 1.7**

### Property 3: Selection word count accuracy

*For any* text selection (single or multiple), the displayed word count should equal the sum of word counts of all selected text regions.

**Validates: Requirements 2.1, 2.4**

### Property 4: Document word count accuracy

*For any* document text, when no text is selected, the displayed word count should equal the word count of the entire document.

**Validates: Requirements 3.1**

### Property 5: Whitespace splitting behavior

*For any* text string, the word count should be calculated by splitting on whitespace boundaries (spaces, tabs, newlines), treating consecutive whitespace characters as a single separator.

**Validates: Requirements 4.1, 4.2**

### Property 6: Leading and trailing whitespace invariant

*For any* text string, adding or removing leading or trailing whitespace should not change the word count.

**Validates: Requirements 4.3**

## Error Handling

The word count feature has minimal error handling requirements since it operates on text that is always available from the VS Code API. However, the following defensive practices should be implemented:

**Null/Undefined Checks:**
- Check if `vscode.window.activeTextEditor` is defined before accessing it
- Check if `document` exists before checking `languageId`
- Handle empty selections array gracefully

**Edge Cases:**
- Empty documents (word count = 0)
- Documents with only whitespace (word count = 0)
- Very large documents (should still calculate correctly, performance handled by VS Code's text model)

**Disposal:**
- Ensure all event listeners are properly disposed when the extension deactivates
- Dispose the status bar item to prevent resource leaks

## Testing Strategy

The word count feature will be tested using a dual approach combining unit tests and property-based tests.

### Unit Tests

Unit tests will verify specific examples and edge cases:

1. **Word count calculation examples:**
   - Empty string returns 0
   - Single word returns 1
   - Multiple words with various whitespace
   - Hyphenated words (e.g., "hello-world" counts as 1)
   - Words with numbers (e.g., "test123" counts as 1)

2. **Status bar visibility:**
   - Status bar shown for markdown documents
   - Status bar shown for plaintext documents
   - Status bar hidden for other document types (e.g., TypeScript, JSON)
   - Status bar hidden when no editor is active

3. **Resource cleanup:**
   - Verify dispose() cleans up status bar item
   - Verify dispose() cleans up event listeners

### Property-Based Tests

Property-based tests will verify universal properties across many generated inputs using fast-check. Each test will run a minimum of 100 iterations.

1. **Property 1: Status bar text format**
   - Generate random non-negative integers
   - Verify format matches "$(book) N Words"
   - **Feature: word-count-status-bar, Property 1: Status bar text format**

2. **Property 2: Text document detection**
   - Generate random language IDs
   - Verify isTextDocument returns true only for "markdown" and "plaintext"
   - **Feature: word-count-status-bar, Property 2: Text document detection**

3. **Property 3: Selection word count accuracy**
   - Generate random text selections (single and multiple)
   - Verify displayed count equals sum of individual selection counts
   - **Feature: word-count-status-bar, Property 3: Selection word count accuracy**

4. **Property 4: Document word count accuracy**
   - Generate random document text
   - Verify displayed count equals document word count when no selection
   - **Feature: word-count-status-bar, Property 4: Document word count accuracy**

5. **Property 5: Whitespace splitting behavior**
   - Generate random text with various whitespace patterns
   - Verify word count matches expected split behavior
   - **Feature: word-count-status-bar, Property 5: Whitespace splitting behavior**

6. **Property 6: Leading and trailing whitespace invariant**
   - Generate random text
   - Add random leading/trailing whitespace
   - Verify word count remains unchanged
   - **Feature: word-count-status-bar, Property 6: Leading and trailing whitespace invariant**

### Testing Framework

- **Test runner:** Bun test (following existing mdmarkup conventions)
- **Property-based testing library:** fast-check
- **Test file location:** `src/wordcount.test.ts`
- **Minimum iterations per property test:** 100

### Integration Testing

While not part of automated testing, manual integration testing should verify:
- Status bar updates when switching between documents
- Status bar updates when changing selections
- Status bar updates when editing document content
- Performance is acceptable for large documents (>10,000 words)
