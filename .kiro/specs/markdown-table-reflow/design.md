# Design Document: Markdown Table Reflow

## Overview

This feature adds a "Reflow Table" command to the Markdown Formatting context menu. The command reformats Markdown tables to ensure proper column alignment and consistent spacing, making tables more readable in the source editor. The implementation follows the existing extension architecture, using the TextTransformation pattern and integrating with the VS Code command system.

## Architecture

The feature integrates into the existing extension architecture:

1. **Command Registration**: Register `markdown.reflowTable` command in `extension.ts`
2. **Formatting Logic**: Implement table reflow logic in `formatting.ts` 
3. **Menu Configuration**: Update `package.json` to add the menu item with proper positioning and dividers
4. **Command Handler**: Use the existing `applyLineBasedFormatting` helper to handle text replacement

The table reflow command will follow the same pattern as other markdown formatting commands (headings, lists, etc.) that operate on line-based content.

## Components and Interfaces

### 1. Table Detection and Parsing

**Module**: `formatting.ts`

**Interface**:
```typescript
interface TableRow {
  cells: string[];
  isSeparator: boolean;
}

interface ParsedTable {
  rows: TableRow[];
  columnWidths: number[];
}
```

**Functions**:
- `parseTable(text: string): ParsedTable | null` - Parses markdown table text into structured data
- `isTableRow(line: string): boolean` - Determines if a line is a valid table row
- `isSeparatorRow(line: string): boolean` - Determines if a line is a header separator

### 2. Table Formatting

**Module**: `formatting.ts`

**Function**:
```typescript
export function reflowTable(text: string): TextTransformation
```

This function:
1. Parses the input text as a table
2. Calculates optimal column widths
3. Formats each row with proper alignment
4. Returns the formatted table as a TextTransformation

### 3. Command Registration

**Module**: `extension.ts`

Register the command using the existing `applyLineBasedFormatting` helper:

```typescript
vscode.commands.registerCommand('markdown.reflowTable', () => 
  applyLineBasedFormatting((text) => formatting.reflowTable(text))
)
```

### 4. Menu Configuration

**Module**: `package.json`

Add command definition and menu entry with proper group positioning to create dividers.

## Data Models

### TableRow
Represents a single row in a markdown table:
- `cells: string[]` - Array of cell contents (trimmed)
- `isSeparator: boolean` - True if this is the header separator row

### ParsedTable
Represents the complete parsed table structure:
- `rows: TableRow[]` - All rows in the table
- `columnWidths: number[]` - Maximum width for each column

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*


### Property Reflection

After analyzing the acceptance criteria, several properties can be combined to eliminate redundancy:

- Requirements 1.3, 2.1, and 2.2 all test table reflow functionality and can be combined into a single comprehensive property
- Requirements 3.1, 3.2, 3.3, and 3.5 all relate to column alignment and can be combined into one property about proper formatting
- Requirements 1.4, 1.5, and 3.4 represent distinct invariants that should remain separate

### Correctness Properties

Property 1: Content preservation through reflow
*For any* valid markdown table, reflowing the table should preserve all cell contents exactly - extracting cells from the original and reflowed tables should yield identical content arrays.
**Validates: Requirements 1.4**

Property 2: Separator row preservation
*For any* table with a header separator row (second row with hyphens and pipes), reflowing should maintain a valid separator row in the same position with appropriate hyphen padding.
**Validates: Requirements 1.5**

Property 3: Column alignment consistency
*For any* valid markdown table, after reflowing, all pipes in the same column position should be vertically aligned, with each cell padded to match the maximum content width in that column, and exactly one space between pipes and content.
**Validates: Requirements 1.3, 3.1, 3.2, 3.3, 3.5**

Property 4: Whitespace preservation within cells
*For any* table cell containing leading or trailing spaces, reflowing should preserve those spaces within the cell content (distinct from the padding added for alignment).
**Validates: Requirements 3.4**

## Error Handling

The table reflow command should handle the following error conditions:

1. **Non-table content**: If the selected text is not a valid markdown table, display an informational message: "No valid markdown table found in selection"
2. **Empty selection**: If no text is selected and cursor is not in a table, display: "Place cursor in a table or select table text to reflow"
3. **Malformed tables**: Tables with inconsistent column counts should be handled gracefully - reflow based on the maximum column count found
4. **Empty tables**: Tables with no content rows (only separator) should be left unchanged

## Testing Strategy

### Unit Testing

Unit tests will verify specific examples and edge cases:

1. **Basic table formatting**: Test a simple 2x2 table reformats correctly
2. **Header separator handling**: Test that separator rows are properly formatted
3. **Empty cells**: Test tables with empty cells maintain structure
4. **Varying column widths**: Test that columns are sized to widest content
5. **Malformed input**: Test graceful handling of invalid table syntax

### Property-Based Testing

Property-based tests will verify universal properties across many randomly generated inputs using the fast-check library (already in devDependencies):

- **Library**: fast-check (already available in the project)
- **Configuration**: Each property test should run a minimum of 100 iterations
- **Tagging**: Each test must reference its corresponding design property using the format: `**Feature: markdown-table-reflow, Property {number}: {property_text}**`

Property tests to implement:

1. **Content Preservation Property**: Generate random tables with varying cell contents, reflow them, and verify all cell contents are preserved
2. **Separator Preservation Property**: Generate random tables with separator rows, reflow them, and verify separator remains valid
3. **Alignment Property**: Generate random tables, reflow them, and verify all pipes align vertically and cells are properly padded
4. **Whitespace Preservation Property**: Generate tables with cells containing leading/trailing spaces, reflow them, and verify those spaces are preserved

Each property-based test will be implemented as a single test that validates its corresponding correctness property.

## Implementation Notes

### Table Detection Algorithm

1. Split input text into lines
2. Check if each line matches table row pattern: starts/ends with `|` and contains at least one `|` separator
3. Identify separator row: line with pattern `|[-:| ]+|`
4. If valid table structure found, proceed with reflow

### Column Width Calculation

1. Parse all rows into cell arrays
2. For each column index, find maximum cell content length across all rows
3. Use these maximum lengths as column widths for formatting

### Row Formatting

1. For content rows: `| {cell_content}{padding} |` where padding brings total to column width
2. For separator rows: `| {hyphens} |` where hyphens count equals column width
3. Maintain single space between pipe and content: `| content |`

### Integration Points

- Uses existing `applyLineBasedFormatting` helper from `extension.ts`
- Follows `TextTransformation` interface from `formatting.ts`
- Integrates with VS Code command system via `package.json` configuration
