# Implementation Plan: Word Count Status Bar

## Overview

This implementation plan breaks down the word count status bar feature into discrete coding tasks. The feature will be implemented in a new module (`src/wordcount.ts`) following the existing mdmarkup extension architecture. Each task builds incrementally, with testing integrated throughout to validate correctness early.

## Tasks

- [x] 1. Create word count module with core calculation function
  - Create `src/wordcount.ts` file
  - Implement `countWords(text: string): number` function using whitespace splitting algorithm
  - Export the function for use by the controller
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 1.1 Write property tests for word count calculation
  - **Property 5: Whitespace splitting behavior**
  - **Validates: Requirements 4.1, 4.2**
  - **Property 6: Leading and trailing whitespace invariant**
  - **Validates: Requirements 4.3**

- [x] 1.2 Write unit tests for word count edge cases
  - Test empty string returns 0
  - Test single word returns 1
  - Test hyphenated words count as one
  - Test words with numbers count as one
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 2. Implement WordCountController class structure
  - [x] 2.1 Create WordCountController class with constructor
    - Define private properties: `statusBarItem` and `disposables` array
    - Create status bar item with left alignment and priority 100
    - Initialize disposables array
    - _Requirements: 1.1, 1.6, 5.1, 5.4_
  
  - [x] 2.2 Implement isTextDocument helper method
    - Check if document.languageId is "markdown" or "plaintext"
    - Return boolean result
    - _Requirements: 1.2, 1.7_
  
  - [x] 2.3 Write property test for text document detection
    - **Property 2: Text document detection**
    - **Validates: Requirements 1.7**

- [ ] 3. Implement status bar update logic
  - [x] 3.1 Implement updateWordCount method
    - Get active text editor
    - Check if editor exists and document is text document
    - Hide status bar if not applicable
    - Get selections from editor
    - Calculate word count based on selection state (empty vs non-empty)
    - Format status bar text as "$(book) N Words"
    - Show status bar item
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.3, 2.4, 3.1_
  
  - [x] 3.2 Write property test for status bar text format
    - **Property 1: Status bar text format**
    - **Validates: Requirements 1.4**
  
  - [x] 3.3 Write property tests for word count accuracy
    - **Property 3: Selection word count accuracy**
    - **Validates: Requirements 2.1, 2.4**
    - **Property 4: Document word count accuracy**
    - **Validates: Requirements 3.1**

- [ ] 4. Register event listeners in WordCountController
  - [x] 4.1 Register onDidChangeActiveTextEditor listener
    - Add listener to disposables array
    - Call updateWordCount on editor change
    - _Requirements: 3.3, 5.5_
  
  - [x] 4.2 Register onDidChangeTextEditorSelection listener
    - Add listener to disposables array
    - Call updateWordCount on selection change
    - _Requirements: 2.2, 5.5_
  
  - [x] 4.3 Register onDidChangeTextDocument listener
    - Add listener to disposables array
    - Call updateWordCount on document change
    - _Requirements: 3.2, 5.5_
  
  - [x] 4.4 Perform initial update in constructor
    - Call updateWordCount after registering listeners
    - _Requirements: 1.1_

- [x] 5. Implement dispose method
  - Dispose status bar item
  - Dispose all event listeners in disposables array
  - _Requirements: 5.2_

- [x] 5.1 Write unit tests for resource cleanup
  - Verify dispose cleans up status bar item
  - Verify dispose cleans up event listeners
  - _Requirements: 5.2_

- [ ] 6. Integrate WordCountController into extension activation
  - [x] 6.1 Import WordCountController in src/extension.ts
    - Add import statement for WordCountController
    - _Requirements: 5.1_
  
  - [x] 6.2 Create and register WordCountController instance
    - Instantiate WordCountController in activate function
    - Add controller to context.subscriptions for disposal
    - _Requirements: 5.1, 5.2_

- [x] 7. Checkpoint - Ensure all tests pass
  - Run `bun test` to verify all unit and property tests pass
  - Manually test in VS Code by installing the extension
  - Verify status bar appears for markdown and plaintext files
  - Verify status bar updates when selecting text
  - Verify status bar updates when editing document
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests use fast-check with minimum 100 iterations
- The checkpoint ensures incremental validation before completion
- Follow existing mdmarkup patterns for code organization and testing
