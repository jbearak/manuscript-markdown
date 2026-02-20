# Bugfix Requirements Document

## Introduction

When the md-to-docx converter exports a citation that did not originate from Zotero (i.e., a BibTeX entry without `zotero-key`/`zotero-uri` fields), the exported DOCX text is initially correct. However, when Zotero's Word plugin interacts with the citation — via "Add/Edit Citation", "Refresh", or a style change — Zotero misidentifies the item and replaces the correct citation text with a wrong reference.

The root cause is that non-Zotero citation items in the field code are assigned small sequential numeric `id` values (1, 2, 3, …) without any `uris` array. When Zotero's Word plugin processes the field code, it uses the `id` to look up items in its library. Small integers collide with real Zotero library item IDs, causing Zotero to match the citation to an unrelated item in the user's library. The `itemData` embedded in the field code is correct, but Zotero trusts the `id`-based lookup over the embedded data when refreshing.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a non-Zotero BibTeX entry (no `zotero-key`/`zotero-uri`) is exported as a `ZOTERO_ITEM CSL_CITATION` field code THEN the system assigns a small sequential numeric `id` (e.g., 1, 2, 3) to the `citationItem` and `itemData` that is likely to collide with a real Zotero library item ID

1.2 WHEN a non-Zotero citation item has a colliding numeric `id` and the user clicks "Add/Edit Citation" in Zotero's Word plugin THEN Zotero resolves the `id` to a different item in the user's library and displays/replaces the citation with the wrong reference

1.3 WHEN a non-Zotero citation item has a colliding numeric `id` and the user clicks "Refresh" or changes the citation style in Zotero's Word plugin THEN Zotero overwrites the correct citation text with text from the misidentified library item

### Expected Behavior (Correct)

2.1 WHEN a non-Zotero BibTeX entry is exported as a `ZOTERO_ITEM CSL_CITATION` field code THEN the system SHALL assign the citation key string as the `id` for the `citationItem` and `itemData`, which cannot match any Zotero library item (Zotero uses numeric IDs internally)

2.2 WHEN a non-Zotero citation item has a string `id` and the user clicks "Add/Edit Citation" in Zotero's Word plugin THEN Zotero SHALL not find a matching library item and SHALL fall back to the embedded `itemData`, preserving the correct citation

2.3 WHEN a non-Zotero citation item has a string `id` and the user clicks "Refresh" or changes the citation style THEN Zotero SHALL use the embedded `itemData` to re-render the citation, preserving the correct bibliographic content

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a Zotero-linked BibTeX entry (with `zotero-key` and `zotero-uri`) is exported THEN the system SHALL CONTINUE TO include the `uris` array in the `citationItem` and assign a stable numeric `id`, so Zotero can correctly identify the item via URI

3.2 WHEN multiple citations reference the same non-Zotero entry across the document THEN the system SHALL CONTINUE TO assign the same `id` to all instances of that entry (stable mapping), ensuring Zotero treats them as the same item

3.3 WHEN a grouped citation contains both Zotero and non-Zotero entries THEN the system SHALL CONTINUE TO produce a single field code containing all resolved entries, with Zotero entries having `uris` and non-Zotero entries having string `id` values

3.4 WHEN a citation key is not found in the BibTeX file THEN the system SHALL CONTINUE TO render it as plain text with a warning, not as a field code
