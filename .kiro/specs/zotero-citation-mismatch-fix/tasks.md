# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Fault Condition** - Non-Zotero Entries Receive Small Sequential IDs
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to non-Zotero BibtexEntry inputs (no `zoteroKey`/`zoteroUri`), using fast-check with short bounded generators to avoid timeouts
  - Create test file `src/zotero-citation-id.property.test.ts`
  - Generate non-Zotero BibtexEntry objects (random `key`, `type`, `fields` with title/author but no `zotero-key`/`zotero-uri`)
  - Call `buildCitationFieldCode()` with the entry, parse the CSL_CITATION JSON from the resulting field code XML
  - Assert that `citationItem.id` is a string (the citation key), not a small sequential number
  - Assert that `citationItem.itemData.id` equals `citationItem.id`
  - Run test on UNFIXED code - expect FAILURE (IDs will be small sequential numbers like 1, 2, 3)
  - Document counterexamples found (e.g., "non-Zotero entry gets id: 1 instead of the citation key string")
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 2.1_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Zotero-Linked Entries and Stable Mapping Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - **Scoped PBT Approach**: Use fast-check with short bounded generators to avoid timeouts
  - Create preservation tests in `src/zotero-citation-id.property.test.ts`
  - Observe on UNFIXED code: Zotero-linked entries (with `zoteroUri`) produce `uris` arrays and stable numeric IDs
  - Observe on UNFIXED code: Same citation key referenced multiple times gets the same ID (stable mapping via `itemIdMap`)
  - Observe on UNFIXED code: Grouped citations with both Zotero and non-Zotero entries produce a single field code with all entries
  - Write property-based test: for all BibtexEntry with `zoteroUri` defined, the field code contains a `uris` array with the entry's `zoteroUri`
  - Write property-based test: for any citation key called twice with the same `itemIdMap`, both calls produce the same `id`
  - Verify tests PASS on UNFIXED code
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3_

- [x] 3. Fix non-Zotero citation ID assignment in `buildCitationFieldCode()` — use string IDs

  - [x] 3.1 Implement the revised fix in `src/md-to-docx-citations.ts`
    - In `buildCitationFieldCode()`, when `itemIdMap.get(key)` returns `undefined` AND the entry has no `zoteroUri`, use the citation key string as the `id` instead of any numeric value
    - Change `itemIdMap` type from `Map<string, number>` to `Map<string, string | number>` to accommodate string IDs
    - When the entry has a `zoteroUri`, continue using `itemIdMap.size + 1` (Zotero resolves by URI, not numeric ID)
    - Preserve existing `itemIdMap` lookup for repeat references (if key already mapped, reuse its ID)
    - Do not change `uris` assignment logic or any other part of the field code structure
    - Update all call sites and test files that create `itemIdMap` to use the new type
    - _Expected_Behavior: Non-Zotero entries get citation key string as id; Zotero entries unchanged_
    - _Preservation: Zotero-linked entries keep uris arrays and stable IDs; stable mapping maintained; missing keys still plain text_
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4_

  - [x] 3.2 Update property tests for string ID approach
    - Update the exploration test (Property 1) to assert `citationItem.id` is a string equal to the citation key
    - Update the stable mapping test (Property 2b) to work with `Map<string, string | number>`
    - Update the grouped citation test (Property 2c) to check non-Zotero items have string IDs
    - _Requirements: 2.1, 2.2, 2.3, 3.2, 3.3_

  - [x] 3.3 Verify all property tests pass
    - Run all property-based tests (exploration + preservation)
    - **EXPECTED OUTCOME**: All tests PASS (confirms fix works and no regressions)
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3_

- [x] 4. Checkpoint - Ensure all tests pass
  - Run full test suite to ensure no regressions across the codebase
  - Ensure all property-based tests pass
  - Ask the user if questions arise

- [x] 5. Add synthetic `uris` array for non-Zotero entries

  - [x] 5.1 Implement synthetic uris in buildCitationFieldCode
    - In `buildCitationFieldCode()`, after building the `citationItem`, add a `uris` array for non-Zotero entries
    - Use a synthetic URI format: `http://zotero.org/users/local/embedded/items/<key>` where `<key>` is the citation key
    - This ensures Zotero's `loadItemData()` takes the URI resolution path, fails to find the item, and falls back to embedded `itemData`
    - Without `uris`, Zotero tries `Zotero.Items.get(citationItem.id)` which crashes on string IDs, or the embedded fallback crashes iterating `citationItem.uris.length` on undefined
    - Keep the existing `uris` assignment for Zotero-linked entries unchanged (real `zoteroUri`)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 5.2 Update property tests for synthetic uris
    - Update exploration test (Property 1) to also assert `citationItem.uris` is an array containing the synthetic URI
    - Update grouped citation test (Property 2c) to verify non-Zotero items have synthetic `uris`
    - _Requirements: 2.1, 3.3_

  - [x] 5.3 Verify all property tests pass
    - Run all property-based tests (exploration + preservation)
    - **EXPECTED OUTCOME**: All tests PASS
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3_

- [x] 6. Final checkpoint - Ensure all tests pass
  - Run full test suite to ensure no regressions across the codebase
  - Ensure all property-based tests pass
  - Ask the user if questions arise
