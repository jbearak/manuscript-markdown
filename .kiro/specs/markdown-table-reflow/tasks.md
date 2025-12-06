# Implementation Plan

- [x] 1. Implement table parsing and detection logic
  - [x] 1.1 Create table detection functions in formatting.ts
    - Write `isTableRow()` to identify valid table rows
    - Write `isSeparatorRow()` to identify header separators
    - Write `parseTable()` to parse table text into structured data
    - _Requirements: 2.1, 2.3_

  - [x] 1.2 Write property test for content preservation
    - **Property 1: Content preservation through reflow**
    - **Validates: Requirements 1.4**
    - _Requirements: 1.4_

- [x] 2. Implement table formatting logic
  - [x] 2.1 Create column width calculation function
    - Write logic to calculate maximum width for each column
    - Handle empty cells and varying content lengths
    - _Requirements: 3.3_

  - [x] 2.2 Create row formatting functions
    - Write logic to format content rows with proper padding
    - Write logic to format separator rows with hyphens
    - Ensure single space between pipes and content
    - _Requirements: 3.1, 3.2, 3.5_

  - [x] 2.3 Write property test for alignment consistency
    - **Property 3: Column alignment consistency**
    - **Validates: Requirements 1.3, 3.1, 3.2, 3.3, 3.5**
    - _Requirements: 1.3, 3.1, 3.2, 3.3, 3.5_

  - [x] 2.4 Implement main reflowTable function
    - Integrate parsing, width calculation, and formatting
    - Return TextTransformation with formatted table
    - Handle edge cases (empty tables, malformed input)
    - _Requirements: 1.3, 2.2_

  - [x] 2.5 Write property test for separator preservation
    - **Property 2: Separator row preservation**
    - **Validates: Requirements 1.5**
    - _Requirements: 1.5_

  - [x] 2.6 Write property test for whitespace preservation
    - **Property 4: Whitespace preservation within cells**
    - **Validates: Requirements 3.4**
    - _Requirements: 3.4_

  - [x] 2.7 Write unit tests for table formatting
    - Test basic 2x2 table formatting
    - Test tables with empty cells
    - Test tables with varying column widths
    - Test malformed table handling
    - _Requirements: 1.3, 3.1, 3.2, 3.3_

- [x] 3. Register command and update menu configuration
  - [x] 3.1 Register markdown.reflowTable command in extension.ts
    - Add command registration using applyLineBasedFormatting helper
    - Wire up to formatting.reflowTable function
    - _Requirements: 1.3, 2.1, 2.2_

  - [x] 3.2 Update package.json with command and menu configuration
    - Add command definition for markdown.reflowTable
    - Add menu entry in markdown.formatting submenu
    - Position above heading submenu with proper group numbering
    - Use group "2_tables@5" to create divider separation
    - _Requirements: 1.1, 1.2_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
