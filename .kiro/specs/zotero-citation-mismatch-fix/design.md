# Zotero Citation ID Mismatch Bugfix Design

## Overview

The `buildCitationFieldCode()` function in `src/md-to-docx-citations.ts` assigns small sequential numeric IDs (1, 2, 3…) to non-Zotero citation items via an `itemIdMap`. These small IDs collide with real Zotero library item IDs, causing Zotero's Word plugin to misidentify citations when the user refreshes, edits, or changes citation style.

The fix has two parts: (1) use the citation key string as the `id` for non-Zotero entries instead of a numeric ID, and (2) add a synthetic `uris` array with a non-resolvable URI. Zotero's `loadItemData()` in `integration.js` requires `citationItem.uris` to be present — when it can't resolve the URI, it falls back to the embedded `itemData`. Without `uris`, the code crashes trying to iterate `citationItem.uris.length`. This mimics the behavior of shared documents where the recipient's Zotero can't resolve the original author's URIs and gracefully uses embedded data. Zotero-linked entries (those with `zoteroUri`) continue to use their real URIs and numeric IDs and are unaffected.

## Glossary

- **Bug_Condition (C)**: A non-Zotero BibTeX entry (no `zoteroKey`/`zoteroUri`) is exported as a ZOTERO_ITEM CSL_CITATION field code and receives a small sequential numeric `id` that collides with a real Zotero library item ID
- **Property (P)**: Non-Zotero entries receive their citation key string as the `id`, which Zotero cannot match to any library item, causing Zotero to fall back to embedded `itemData`
- **Preservation**: Zotero-linked entries continue to receive `uris` arrays and stable IDs; stable mapping across the document is maintained; missing keys still render as plain text
- **buildCitationFieldCode()**: The function in `src/md-to-docx-citations.ts` that constructs the CSL_CITATION JSON field code for DOCX export
- **itemIdMap**: A `Map<string, string | number>` that tracks citation key → ID assignments across the document to ensure the same key always gets the same ID. Non-Zotero entries get string IDs (the citation key); Zotero entries get numeric IDs.
- **BibtexEntry**: Interface in `src/bibtex-parser.ts` with optional `zoteroKey` and `zoteroUri` fields indicating Zotero provenance

## Bug Details

### Fault Condition

The bug manifests when a non-Zotero BibTeX entry (one without `zoteroKey`/`zoteroUri` fields) is exported as a ZOTERO_ITEM CSL_CITATION field code. The `buildCitationFieldCode()` function assigns `itemIdMap.size + 1` as the numeric ID, producing small integers (1, 2, 3…) that overlap with Zotero's internal library item ID space. When Zotero's Word plugin processes the field code, it uses the `id` field to look up items in its library, finds a match with an unrelated item, and replaces the citation text.

**Formal Specification:**
```
FUNCTION isBugCondition(entry, itemIdMap)
  INPUT: entry of type BibtexEntry, itemIdMap of type Map<string, number>
  OUTPUT: boolean

  RETURN entry.zoteroKey IS undefined
         AND entry.zoteroUri IS undefined
         AND itemIdMap.get(entry.key) IS undefined
         AND (itemIdMap.size + 1) < 1_000_000
END FUNCTION
```

### Examples

- Entry `smith2020` (no Zotero fields) is the first non-Zotero entry → gets `id: 1`. Zotero library item #1 is "Darwin 1859" → Zotero replaces "Smith 2020" with "Darwin 1859" on refresh.
- Entry `doe2021` (no Zotero fields) is the second non-Zotero entry → gets `id: 2`. Zotero library item #2 is "Einstein 1905" → citation is replaced on style change.
- Entry `jones2022` (has `zotero-key = {XXXX1234}`, `zotero-uri = {http://zotero.org/users/0/items/XXXX1234}`) → gets `uris` array, Zotero resolves correctly via URI. No bug.
- Grouped citation `[@smith2020; @jones2022]` → `smith2020` gets `id: 1` (collides), `jones2022` gets `uris` (correct). Only the non-Zotero entry is misidentified.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Zotero-linked entries (with `zoteroKey` and `zoteroUri`) must continue to include `uris` arrays in their `citationItem` and receive stable numeric IDs
- The same citation key appearing multiple times in a document must continue to receive the same numeric ID (stable mapping via `itemIdMap`)
- Grouped citations containing both Zotero and non-Zotero entries must continue to produce a single field code with all entries
- Missing citation keys must continue to render as plain text with a warning, not as field codes
- The `citationID`, `properties` (formattedCitation, plainCitation), `schema`, and overall field code XML structure must remain unchanged
- The `itemData` content (CSL fields built from BibTeX) must remain unchanged

**Scope:**
All inputs that do NOT involve non-Zotero entries receiving new IDs should be completely unaffected by this fix. This includes:
- All Zotero-linked entries (those with `zoteroUri`)
- Non-Zotero entries that already have an assigned ID in `itemIdMap` (repeat references)
- Missing citation keys (no BibTeX entry found)
- The visible citation text rendering
- Bibliography generation

## Hypothesized Root Cause

Based on the bug description and code analysis, the root cause is in `buildCitationFieldCode()` at the ID assignment logic:

```typescript
if (itemIdMap) {
  let numericId = itemIdMap.get(key);
  if (numericId === undefined) {
    numericId = itemIdMap.size + 1;  // ← BUG: produces 1, 2, 3...
    itemIdMap.set(key, numericId);
  }
  itemData.id = numericId;
}
```

1. **Small Sequential IDs**: `itemIdMap.size + 1` produces IDs starting at 1 and incrementing. Zotero's library uses similar small integer IDs internally, making collisions virtually guaranteed for any user with items in their library.

2. **No Distinction Between Zotero and Non-Zotero Entries**: The ID assignment logic treats all entries identically. Zotero-linked entries get `uris` arrays (added later in the function), so Zotero resolves them by URI regardless of the numeric ID. Non-Zotero entries lack `uris`, so Zotero falls back to the numeric `id` for lookup — and finds the wrong item.

3. **Zotero's Lookup Priority**: Zotero's Word plugin trusts `id`-based lookup over embedded `itemData`. When a small numeric ID matches a library item, Zotero uses the library item's data instead of the embedded CSL data, even though the embedded data is correct.

## Correctness Properties

Property 1: Fault Condition - Non-Zotero Entries Get String IDs

_For any_ BibtexEntry where `zoteroKey` is undefined and `zoteroUri` is undefined, the fixed `buildCitationFieldCode` function SHALL assign the citation key string as the `id` to both the `citationItem.id` and `citationItem.itemData.id`. Since Zotero's library uses numeric IDs internally, a string ID cannot match any library item, causing Zotero to fall back to the embedded `itemData`.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - Zotero-Linked Entries and Stable Mapping

_For any_ BibtexEntry where `zoteroUri` is defined, the fixed function SHALL produce the same `uris` array and stable numeric `id` as the original function. Additionally, _for any_ citation key that appears multiple times in a document, the fixed function SHALL assign the same `id` to all instances, preserving stable mapping.

**Validates: Requirements 3.1, 3.2, 3.3**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `src/md-to-docx-citations.ts`

**Function**: `buildCitationFieldCode()`

**Specific Changes**:

1. **Replace Sequential Numeric ID with Citation Key String for Non-Zotero Entries**: When `itemIdMap.get(key)` returns `undefined` AND the entry has no `zoteroUri`, use the citation key string (e.g., `"smith2020"`) as the `id` instead of `itemIdMap.size + 1`. The CSL spec explicitly allows string IDs. Zotero's library uses numeric IDs internally, so a string ID cannot match any library item.

2. **Keep Sequential ID for Zotero-Linked Entries**: When the entry has a `zoteroUri`, continue using `itemIdMap.size + 1` (or any stable scheme) since Zotero resolves these by URI, not by numeric ID.

3. **Change `itemIdMap` Type**: Update `itemIdMap` from `Map<string, number>` to `Map<string, string | number>` to accommodate string IDs for non-Zotero entries.

4. **Preserve Stable Mapping**: The `itemIdMap` lookup (`itemIdMap.get(key)`) already handles repeat references — if a key was previously assigned an ID, it reuses it. This logic remains unchanged.

5. **No Changes to `uris` Assignment**: The existing logic that adds `uris` for entries with `zoteroUri` remains untouched.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Fault Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that create non-Zotero BibTeX entries, pass them through `buildCitationFieldCode()`, parse the resulting JSON from the field code, and assert that the numeric `id` is large. Run these tests on the UNFIXED code to observe failures (IDs will be small sequential numbers).

**Test Cases**:
1. **Single Non-Zotero Entry**: Create one entry without `zoteroKey`/`zoteroUri`, export it, verify the `id` in the JSON is >= 1,000,000 (will fail on unfixed code — gets `id: 1`)
2. **Multiple Non-Zotero Entries**: Create 3 entries without Zotero fields, export them, verify all IDs are >= 1,000,000 (will fail on unfixed code — gets `id: 1, 2, 3`)
3. **Mixed Zotero and Non-Zotero**: Create a grouped citation with one Zotero entry and one non-Zotero entry, verify the non-Zotero entry's `id` is >= 1,000,000 (will fail on unfixed code)

**Expected Counterexamples**:
- Non-Zotero entries receive IDs like 1, 2, 3 instead of large random numbers
- Root cause confirmed: `itemIdMap.size + 1` produces small sequential IDs

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL entry WHERE NOT entry.zoteroUri AND NOT entry.zoteroKey DO
  result := buildCitationFieldCode_fixed([entry.key], entries, ...)
  parsedJson := extractCSLCitationJSON(result)
  FOR EACH citationItem IN parsedJson.citationItems DO
    ASSERT citationItem.id >= 1_000_000
    ASSERT citationItem.id <= 9_999_999
    ASSERT citationItem.itemData.id == citationItem.id
  END FOR
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL entry WHERE entry.zoteroUri IS defined DO
  original := buildCitationFieldCode_original([entry.key], entries, ...)
  fixed := buildCitationFieldCode_fixed([entry.key], entries, ...)
  ASSERT extractUris(original) == extractUris(fixed)
  ASSERT extractItemData(original) == extractItemData(fixed)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many random BibTeX entries with Zotero fields and verifies the output is unchanged
- It catches edge cases like entries with unusual field combinations
- It provides strong guarantees that Zotero-linked behavior is preserved

**Test Plan**: Observe behavior on UNFIXED code first for Zotero-linked entries and stable mapping, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Zotero Entry Preservation**: Verify Zotero-linked entries still get `uris` arrays and consistent IDs after the fix
2. **Stable Mapping Preservation**: Verify the same non-Zotero key referenced twice gets the same large random ID both times
3. **Mixed Group Preservation**: Verify grouped citations with both Zotero and non-Zotero entries produce correct field codes
4. **Missing Key Preservation**: Verify missing citation keys still render as plain text with warnings

### Unit Tests

- Test that a single non-Zotero entry gets an ID >= 1,000,000
- Test that a Zotero-linked entry still gets `uris` and a stable ID
- Test that the same non-Zotero key gets the same ID when referenced multiple times
- Test mixed grouped citations produce correct field codes
- Test edge case: entry with `zoteroUri` but no `zoteroKey`

### Property-Based Tests

- Generate random sets of non-Zotero BibTeX entries and verify all assigned IDs are in [1,000,000, 9,999,999] with no duplicates
- Generate random Zotero-linked entries and verify `uris` arrays are preserved and IDs are stable
- Generate random mixes of Zotero and non-Zotero entries and verify correct ID assignment for each type

### Integration Tests

- Test full `generateCitation()` flow with non-Zotero entries and verify field code JSON contains large IDs
- Test full flow with mixed Zotero/non-Zotero grouped citations
- Test that `itemIdMap` maintains stable mapping across multiple `generateCitation()` calls in a document
