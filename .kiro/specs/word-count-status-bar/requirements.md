# Requirements Document

## Introduction

This document specifies the requirements for adding a word count status bar item to the mdmarkup VS Code extension. The feature will display word count information in the VS Code status bar, showing either the word count of the selected text or the entire document when no selection is active. This feature will allow users to uninstall Microsoft's word count sample extension by providing equivalent functionality integrated directly into mdmarkup.

## Glossary

- **Status_Bar**: The horizontal bar at the bottom of the VS Code window that displays contextual information
- **Status_Bar_Item**: A single element displayed in the Status_Bar
- **Word_Count**: The number of words in a text, calculated by splitting on whitespace boundaries
- **Active_Editor**: The currently focused text editor window in VS Code
- **Selection**: A range of text highlighted by the user in the Active_Editor
- **Document**: The complete text content of a file open in the Active_Editor
- **Markdown_Document**: A document with Markdown language mode
- **Plain_Text_Document**: A document with plain text language mode
- **Text_Document**: Either a Markdown_Document or a Plain_Text_Document

## Requirements

### Requirement 1: Status Bar Display

**User Story:** As a user, I want to see word count information in the status bar for text documents, so that I can track document length without external tools.

#### Acceptance Criteria

1. WHEN a Text_Document is open in the Active_Editor, THE Status_Bar SHALL display a Status_Bar_Item showing word count information
2. WHEN the Active_Editor is not a Text_Document, THE Status_Bar_Item SHALL be hidden
3. WHEN the Active_Editor is closed, THE Status_Bar_Item SHALL be hidden
4. THE Status_Bar_Item SHALL display text in the format "$(book) N words" where N is the Word_Count
5. THE Status_Bar_Item SHALL use the "book" icon (Codicon) matching Microsoft's word count extension
5. THE Status_Bar_Item SHALL use the "book" icon (Codicon) matching Microsoft's word count extension
6. THE Status_Bar_Item SHALL be positioned in the left section of the Status_Bar
7. THE Status_Bar_Item SHALL only activate for documents with language mode "markdown" or "plaintext"

### Requirement 2: Selection-Based Word Count

**User Story:** As a user, I want to see the word count of my selected text, so that I can measure specific sections of my document.

#### Acceptance Criteria

1. WHEN text is selected in a Text_Document, THE Status_Bar_Item SHALL display the Word_Count of the Selection
2. WHEN the Selection changes, THE Status_Bar_Item SHALL update immediately to reflect the new Word_Count
3. WHEN the Selection is empty or contains only whitespace, THE Status_Bar_Item SHALL display the Word_Count of the entire Document
4. WHEN multiple selections exist, THE Status_Bar_Item SHALL display the combined Word_Count of all selections

### Requirement 3: Document-Based Word Count

**User Story:** As a user, I want to see the total word count of my document when nothing is selected, so that I can track overall document length.

#### Acceptance Criteria

1. WHEN no text is selected in a Text_Document, THE Status_Bar_Item SHALL display the Word_Count of the entire Document
2. WHEN the Document content changes, THE Status_Bar_Item SHALL update to reflect the new Word_Count
3. WHEN switching between Text_Documents, THE Status_Bar_Item SHALL update to show the Word_Count of the newly active Document

### Requirement 4: Word Count Calculation

**User Story:** As a user, I want accurate word counts, so that I can rely on the displayed numbers for writing goals and requirements.

#### Acceptance Criteria

1. THE Word_Count calculation SHALL split text on whitespace boundaries (spaces, tabs, newlines)
2. THE Word_Count calculation SHALL treat consecutive whitespace characters as a single separator
3. THE Word_Count calculation SHALL exclude leading and trailing whitespace from the count
4. THE Word_Count calculation SHALL count hyphenated words as single words
5. THE Word_Count calculation SHALL count words containing numbers and special characters as valid words

### Requirement 5: Extension Integration

**User Story:** As a developer, I want the word count feature to integrate cleanly with the existing extension architecture, so that it is maintainable and follows established patterns.

#### Acceptance Criteria

1. THE Status_Bar_Item SHALL be created and registered during extension activation in src/extension.ts
2. THE Status_Bar_Item SHALL be disposed when the extension is deactivated
3. THE word count logic SHALL be implemented in a separate module following the existing code organization pattern
4. THE implementation SHALL use VS Code's StatusBarItem API following best practices
5. THE implementation SHALL register event listeners for text selection changes and document content changes

### Requirement 6: Performance

**User Story:** As a user, I want the word count to update quickly, so that it doesn't interfere with my editing experience.

#### Acceptance Criteria

1. WHEN the Selection or Document changes, THE Status_Bar_Item SHALL update within 100 milliseconds
2. THE word count calculation SHALL not block the editor UI thread
3. WHEN processing large documents (>10,000 words), THE Status_Bar_Item SHALL still update within 200 milliseconds
