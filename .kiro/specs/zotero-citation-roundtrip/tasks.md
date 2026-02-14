# Implementation Plan: Zotero Citation Roundtrip

## Overview

Extract Zotero item keys and URIs from DOCX field codes, store them in BibTeX custom fields, and emit locators in Pandoc citation syntax. All changes are in `src/converter.ts`.

## Tasks

- [x] 1. Extend `CitationMetadata` interface and extraction
  - [x] 1.1 Add `zoteroKey?: string`, `zoteroUri?: string`, and `locator?: string` fields to `CitationMetadata` interface
    - _Requirements: 1.1, 1.6, 2.1, 2.2, 3.1_
  - [x] 1.2 In `extractZoteroCitations()`, parse `uris`/`uri` from each citation item, extract item key via `/\/items\/([A-Z0-9]{8})$/`, and capture `locator`
    - Extract first URI from `item.uris ?? item.uri ?? []`
    - Apply regex to extract 8-char key; set `zoteroKey` and `zoteroUri` on `CitationMetadata`
    - Read `item.locator` as string; set `locator` if non-empty
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 2. Emit Zotero fields in BibTeX output
  - [x] 2.1 In `generateBibTeX()`, add `zotero-key` and `zotero-uri` fields after existing fields when present
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 3. Emit locators in Markdown citations
  - [x] 3.1 Update citation rendering in `extractDocumentContent()` or `buildMarkdown()` to emit `[@key, p. <locator>]` when locator is present
    - _Requirements: 3.1, 3.2, 3.3_
  - [x] 3.2 Ensure grouped citations preserve per-item locators: `[@key1, p. 20; @key2]`
    - _Requirements: 3.3, 4.1, 4.2_

- [x] 4. Tests
  - [x] 4.1 Unit test: URI parsing extracts item key from local, synced, and group library URI formats
    - _Requirements: 1.2, 1.3, 1.4, 1.5_
  - [x] 4.2 Unit test: URI parsing handles missing/malformed URIs gracefully
    - _Requirements: 1.6_
  - [x] 4.3 Unit test: `generateBibTeX()` emits `zotero-key` and `zotero-uri` fields; omits them when absent
    - _Requirements: 2.1, 2.2, 2.3_
  - [x] 4.4 Unit test: Markdown citation output includes locator in Pandoc syntax
    - _Requirements: 3.1, 3.2, 3.3_
  - [x] 4.5 Integration test: Convert sample DOCX with Zotero citations end-to-end; verify BibTeX contains `zotero-key` fields and markdown contains locators
    - _Requirements: 1.1, 2.1, 3.1, 4.1_
