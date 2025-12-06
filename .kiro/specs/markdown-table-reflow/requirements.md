# Requirements Document

## Introduction

This feature adds a "Reflow Table" command to the Markdown Formatting context menu in the VS Code CriticMarkup extension. The command will reformat Markdown tables to ensure proper alignment and consistent spacing, making tables more readable and maintainable.

## Glossary

- **Markdown Table**: A text-based table format using pipes (|) and hyphens (-) to define columns and rows
- **Reflow**: The process of reformatting a table to align columns and ensure consistent spacing
- **Context Menu**: The right-click menu that appears in the editor
- **Markdown Formatting Menu**: A submenu in the context menu that contains markdown formatting commands
- **Extension**: The VS Code CriticMarkup extension that provides markdown editing features

## Requirements

### Requirement 1

**User Story:** As a markdown user, I want to reflow tables from the context menu, so that I can quickly format tables without manual alignment.

#### Acceptance Criteria

1. WHEN a user right-clicks in a markdown document THEN the Extension SHALL display the Markdown Formatting submenu with a "Reflow Table" option
2. WHEN the Markdown Formatting submenu is displayed THEN the Extension SHALL position the "Reflow Table" option above the "Heading" submenu with dividers above and below it
3. WHEN a user selects the "Reflow Table" command THEN the Extension SHALL reformat the selected table with aligned columns
4. WHEN a table is reflowed THEN the Extension SHALL preserve all cell content without data loss
5. WHEN a table is reflowed THEN the Extension SHALL maintain the header separator row with appropriate hyphens

### Requirement 2

**User Story:** As a markdown user, I want the reflow command to work on my cursor position, so that I don't have to manually select the entire table.

#### Acceptance Criteria

1. WHEN a user invokes the reflow command with the cursor inside a table THEN the Extension SHALL detect and reflow the entire table
2. WHEN a user invokes the reflow command with text selected THEN the Extension SHALL reflow the selected table content
3. WHEN a user invokes the reflow command outside a table THEN the Extension SHALL display an appropriate message

### Requirement 3

**User Story:** As a markdown user, I want tables to be properly aligned after reflow, so that they are easy to read in the source editor.

#### Acceptance Criteria

1. WHEN a table is reflowed THEN the Extension SHALL align all pipes (|) vertically
2. WHEN a table is reflowed THEN the Extension SHALL pad cell content with spaces to match column width
3. WHEN a table is reflowed THEN the Extension SHALL calculate column width based on the widest content in each column
4. WHEN a table is reflowed THEN the Extension SHALL preserve leading and trailing spaces within cell content
5. WHEN a table is reflowed THEN the Extension SHALL maintain consistent spacing between pipes and cell content
