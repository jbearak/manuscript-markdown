#!/usr/bin/env python3
"""
DOCX to Markdown + BibTeX Converter with Zotero Citation Support

SPECIFICATION:
--------------
Input:  Word document (.docx) with Zotero citations and comments
Output: Markdown file with Critic Markup comments and pandoc citations
        BibTeX file with deduplicated entries and sanitized keys

WHAT: Converts academic Word documents to markdown-ready format
- Extracts Zotero citation metadata from field codes
- Converts numeric citations (1, 2, 3) to pandoc format [@key]
- Renders Word comments as Critic Markup {==text==}{>>comment<<}
- Generates BibTeX entries with clean, unique citation keys

WHY: Enables academic writing workflow from Word to pandoc/markdown
- Preserves reviewer comments for collaborative editing
- Maintains citation integrity from Zotero
- Produces valid BibTeX for reference management
- Avoids false positives (only converts actual Zotero citations)

HOW: Multi-pass extraction and conversion
1. Extract Zotero metadata (JSON in field codes) → citation number mapping
2. Build citation key map (number → author+year+title key)
3. Parse document content, marking Zotero fields and comment ranges
4. Convert citations to pandoc format during markdown generation
5. Generate deduplicated BibTeX with sanitized keys

CITATION KEY RULES:
- Format: {surname}{year}{firstword} (e.g., bearak2020unintended)
- Fallback: author → publisher → journal → "unknown"
- Sanitized: spaces/hyphens removed, lowercase alphanumeric only
- Deduplicated: append numbers if collision (key, key2, key3)

Usage: python3 convert.py <input.docx>
Output: <input>.md and <input>.bib
"""

import zipfile
import xml.etree.ElementTree as ET
import re
import sys
import json
import base64
from pathlib import Path
from collections import defaultdict
from datetime import datetime

def extract_comments(docx_path):
    """
    Extract all comments from Word document.
    
    WHAT: Parses word/comments.xml to extract comment metadata
    WHY:  Comments contain reviewer feedback that needs to be preserved
    HOW:  Uses XML parsing to find comment elements with ID, author, date, text
    
    Word stores comments in word/comments.xml with unique IDs.
    Returns dict mapping comment ID to {author, text, date}.
    """
    comments = {}
    with zipfile.ZipFile(docx_path) as docx:
        try:
            comments_xml = docx.read('word/comments.xml')
            root = ET.fromstring(comments_xml)
            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            for comment in root.findall('.//w:comment', ns):
                comment_id = comment.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}id')
                author = comment.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}author', 'Unknown')
                date = comment.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}date', '')
                text_parts = [t.text for t in comment.findall('.//w:t', ns) if t.text]
                comments[comment_id] = {'author': author, 'text': ''.join(text_parts), 'date': date}
        except KeyError:
            pass  # No comments in document
    return comments

def extract_zotero_metadata(docx_path):
    """
    Extract bibliographic metadata from Zotero citation fields.
    
    WHAT: Parses JSON metadata embedded in Word field codes by Zotero
    WHY:  Zotero stores complete citation data (authors, title, DOI, etc.) in fields
    HOW:  Searches for ZOTERO_ITEM instrText elements, extracts and parses JSON
    
    Zotero stores complete metadata in JSON format within field codes.
    Returns dict mapping citation text (e.g., "1", "1,2") to list of metadata dicts.
    Each metadata dict contains: author, title, year, journal, etc.
    """
    with zipfile.ZipFile(docx_path) as docx:
        document_xml = docx.read('word/document.xml')
    
    root = ET.fromstring(document_xml)
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    
    citation_metadata = {}
    
    for elem in root.findall('.//w:instrText', ns):
        if elem.text and 'ZOTERO_ITEM' in elem.text:
            # Extract JSON from field
            json_start = elem.text.find('{')
            if json_start >= 0:
                try:
                    decoder = json.JSONDecoder()
                    data, _ = decoder.raw_decode(elem.text[json_start:])
                    citation_text = data.get('properties', {}).get('plainCitation', '')
                    items = data.get('citationItems', [])

                    # Extract metadata from each cited item
                    metadata_list = []
                    for item in items:
                        item_data = item.get('itemData', {})
                        metadata = {
                            'authors': item_data.get('author', []),
                            'title': item_data.get('title', ''),
                            'year': '',
                            'journal': item_data.get('container-title', ''),
                            'volume': item_data.get('volume', ''),
                            'pages': item_data.get('page', ''),
                            'doi': item_data.get('DOI', ''),
                            'type': item_data.get('type', 'article-journal'),
                            'zotero_id': item.get('id'),
                            'zotero_uri': item.get('uris', [None])[0] if item.get('uris') else None,
                            'zotero_item_type': item.get('itemType'),
                            'full_item_data': item_data
                        }
                        
                        # Extract year from issued date
                        issued = item_data.get('issued', {})
                        date_parts = issued.get('date-parts', [[]])
                        if date_parts and date_parts[0]:
                            metadata['year'] = str(date_parts[0][0])
                        
                        metadata_list.append(metadata)
                    
                    citation_metadata[citation_text] = metadata_list
                except (json.JSONDecodeError, KeyError):
                    pass
    
    return citation_metadata

def extract_document_content(docx_path):
    """
    Extract document text with comment range markers and citation markers.
    
    WHAT: Parses document.xml to identify text, citations, and comment ranges
    WHY:  Need to know which text has comments and where citations are located
    HOW:  Iterates through XML elements, tracking state (in_citation_field, active_comments)
    
    Word marks comment ranges with commentRangeStart/End tags.
    Zotero citations are marked with field codes containing "ZOTERO_ITEM".
    
    IMPORTANT: Citations are identified ONLY by Zotero field markers, not by
    numeric patterns. This prevents false positives where regular numbers
    (like "20 to 39" or "22 countries") would be mistaken for citations.
    
    Returns list of tuples:
    - ('text', content, active_comment_ids) for regular text
    - ('citation', content, active_comment_ids, full_citation_text) for Zotero citations
    - ('para', None, {}) for paragraph breaks
    
    The full_citation_text (4th element) accumulates all text within a citation field,
    allowing us to capture multi-part citations like "1,2" or "3-5".
    """
    with zipfile.ZipFile(docx_path) as docx:
        document_xml = docx.read('word/document.xml')
    
    root = ET.fromstring(document_xml)
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    
    content = []
    active_comments = set()
    in_citation_field = False
    current_citation_text = ''
    
    for elem in root.iter():
        # Check for Zotero citation field start
        if elem.tag == '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}instrText':
            if elem.text and 'ZOTERO_ITEM' in elem.text:
                in_citation_field = True
                current_citation_text = ''
        
        # Check for field end
        if elem.tag == '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}fldChar':
            fld_type = elem.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}fldCharType')
            if fld_type == 'end' and in_citation_field:
                in_citation_field = False
        
        if elem.tag == '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}commentRangeStart':
            comment_id = elem.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}id')
            active_comments.add(comment_id)
        elif elem.tag == '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}commentRangeEnd':
            comment_id = elem.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}id')
            active_comments.discard(comment_id)
        elif elem.tag == '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t':
            if elem.text:
                if in_citation_field:
                    # Accumulate citation text (may be split across multiple text elements)
                    current_citation_text += elem.text
                    content.append(('citation', elem.text, frozenset(active_comments), current_citation_text))
                else:
                    content.append(('text', elem.text, frozenset(active_comments)))
        elif elem.tag == '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p':
            if content and content[-1][0] != 'para':
                content.append(('para', None, frozenset()))
    
    return content

def build_markdown(content, comments, citation_metadata, citation_keys):
    """
    Build markdown with Critic Markup for comments and pandoc citations.

    WHAT: Converts parsed content to markdown with special markup
    WHY:  Critic Markup preserves comments, pandoc format enables citation processing
    HOW:  Iterates through content, applying markup rules and citation conversion

    Critic Markup syntax:
    - {==highlighted text==} for text with comments
    - {>>Author (date): comment text<<} for each comment (separate blocks per author)

    Citation handling:
    - Citations are converted DIRECTLY from Zotero field markers to pandoc format
    - NO regex matching of numbers in text - only actual Zotero citations are converted
    - This prevents false positives (e.g., "20 to 39" or "22 countries" are NOT citations)
    - Supports both numeric (1, 2, 3) and author-year (Smith 2020) citation formats
    - Output format: [@key] or [@key1; @key2] for multiple citations

    Process:
    1. When 'citation' type is encountered, extract the full citation text
    2. Check if citation text matches a Zotero plainCitation entry
    3. If match found, generate BibTeX keys from Zotero metadata
    4. If no match, try parsing as numeric citations (backwards compatibility)
    5. Convert to pandoc format: [@smith-2020] or [@smith-2020-effects]

    Returns markdown text with citations already converted to pandoc format.
    """
    output = []
    i = 0

    while i < len(content):
        item = content[i]
        item_type = item[0]

        if item_type == 'citation':
            # This is a Zotero citation - convert directly to pandoc format
            # item[3] contains the full accumulated citation text (e.g., "1,2" or "3-5" or "(Smith 2020)")
            cite_text = item[3] if len(item) > 3 else item[1]
            cite_text = cite_text.strip().replace('–', '-')  # Normalize en-dash to hyphen

            keys = []

            # Try to match against Zotero plainCitation entries (author-year format)
            if cite_text in citation_metadata:
                meta_list = citation_metadata[cite_text]
                for meta in meta_list:
                    authors = meta.get('authors', [])
                    if authors and authors[0].get('family'):
                        surname = authors[0].get('family').lower()
                    else:
                        full_data = meta.get('full_item_data', {})
                        publisher = full_data.get('publisher', '')
                        journal = meta.get('journal', '')
                        surname = (publisher or journal or 'unknown').lower()

                    year = meta.get('year', '0000')
                    title = meta.get('title', '')

                    key = generate_citation_key(surname, year, title)
                    keys.append(f"@{key}")
            else:
                # Fallback: try parsing as numeric citations (e.g., "1", "1,2", "3-5")
                nums = re.split(r'[,\-]', cite_text)
                for num in nums:
                    num = num.strip()
                    if num in citation_keys:
                        keys.append(f"@{citation_keys[num]}")

            if keys:
                output.append(f" [{'; '.join(keys)}]")
            else:
                output.append(item[1])  # Fallback to original text if no keys found
            i += 1
        elif item_type == 'text':
            text = item[1]
            text_comments = item[2] if len(item) > 2 else frozenset()
            
            if text_comments:
                # Group consecutive text with same comment set
                full_text = text
                j = i + 1
                while j < len(content) and content[j][0] == 'text' and len(content[j]) > 2 and content[j][2] == text_comments:
                    full_text += content[j][1]
                    j += 1
                
                # Output highlighted text once, followed by separate comment blocks
                output.append(f"{{=={full_text}==}}")
                for cid in sorted(text_comments):
                    if cid in comments:
                        c = comments[cid]
                        date_str = ''
                        if c.get('date'):
                            try:
                                dt = datetime.fromisoformat(c['date'].replace('Z', '+00:00'))
                                date_str = f" ({dt.astimezone().strftime('%Y-%m-%d %H:%M')})"
                            except (ValueError, TypeError):
                                date_str = f" ({c['date']})"
                        output.append(f"{{>>{c['author']}{date_str}: {c['text']}<<}}")
                
                i = j
                continue
            else:
                output.append(text)
        elif item_type == 'para':
            output.append('\n\n')
        
        i += 1
    
    return ''.join(output)

def parse_references(markdown_text):
    """
    Extract numbered references from markdown text.
    
    WHAT: Finds and extracts reference list from "Sources" section
    WHY:  References need to be converted to BibTeX format
    HOW:  Searches for "Sources" heading, then extracts numbered lines
    
    Looks for "Sources" section and extracts lines starting with numbers.
    Returns list of reference strings.
    """
    refs = []
    lines = markdown_text.split('\n')
    in_sources = False
    
    for line in lines:
        if line.strip() == 'Sources':
            in_sources = True
            continue
        if in_sources and line.strip():
            match = re.match(r'^(\d+)\.(.+)$', line.strip())
            if match:
                refs.append(match.group(2).strip())
    
    return refs

def generate_citation_key(surname, year, title):
    """
    Generate citation key in BibTeX format: {surname}-{year} or {surname}-{year}-{word}

    WHAT: Creates unique, readable citation keys for BibTeX
    WHY:  Keys must be valid BibTeX identifiers and human-readable
    HOW:  Combines surname + year + first meaningful title word (optional), with hyphens

    Format follows: surname-year or surname-year-firstword
    Example: smith-2020 or smith-2020-effects

    Excludes articles (the, a, an, of) from title word selection.
    Removes spaces and special characters to ensure valid BibTeX keys.
    """
    # Clean surname: remove spaces and hyphens, keep alphanumerics, convert to lowercase
    clean_surname = re.sub(r'[^a-zA-Z0-9]', '', surname.lower())

    # Extract first meaningful word from title
    words = re.findall(r'\b[a-zA-Z]+\b', title.lower())
    first_word = next((w for w in words if w not in ['the', 'a', 'an', 'of']), '')

    # Return format: surname-year or surname-year-word
    if first_word:
        return f"{clean_surname}-{year}-{first_word}"
    else:
        return f"{clean_surname}-{year}"

def convert_to_bibtex(refs, zotero_metadata, citation_keys):
    """
    Convert reference list to BibTeX format using Zotero metadata.
    
    WHAT: Generates BibTeX entries from references and Zotero data
    WHY:  BibTeX format needed for pandoc citation processing
    HOW:  Uses Zotero metadata when available, falls back to regex parsing
    
    Uses structured metadata from Zotero fields when available, falls back to
    regex parsing of reference text for any missing data.
    
    Citation key strategy:
    1. Use pre-generated key from citation_keys map (ensures consistency)
    2. If missing, generate from: author → publisher → journal → "unknown"
    3. Sanitize to remove spaces/special characters
    
    Preserves Zotero-specific fields in 'zotero-data' field as JSON for restoration.
    
    Returns formatted BibTeX entries with proper citation keys.
    """
    bibtex_entries = []
    
    for i, ref in enumerate(refs, 1):
        # Try to get metadata from Zotero for this reference number
        metadata = None
        raw_zotero_data = None
        key = None
        entry_type = 'misc'

        # Try to find metadata by matching against zotero_metadata
        for cite_text, meta_list in zotero_metadata.items():
            # Parse citation numbers, handling ranges like "3-5" and lists like "1,2"
            cite_nums = []
            for part in cite_text.replace('–', '-').split(','):
                part = part.strip()
                if '-' in part:
                    start, end = part.split('-', 1)
                    if start.strip().isdigit() and end.strip().isdigit():
                        cite_nums.extend(range(int(start.strip()), int(end.strip()) + 1))
                elif part.isdigit():
                    cite_nums.append(int(part))

            if cite_nums and i in cite_nums:
                idx = cite_nums.index(i)
                if idx < len(meta_list):
                    metadata = meta_list[idx]
                    raw_zotero_data = meta_list[idx]
                    break

        # Use pre-generated key if available (for numeric citations)
        if str(i) in citation_keys:
            key = citation_keys[str(i)]
        
        # Initialize variables
        author_str = ''
        title = ''
        year = '0000'
        journal = ''
        volume = ''
        pages = ''
        doi = ''

        if metadata:
            # Use Zotero metadata
            authors = metadata['authors']

            # Use author, fallback to institution/publisher, then journal
            if authors and authors[0].get('family'):
                surname = authors[0].get('family').lower()
            else:
                # Check for institution/publisher in full_item_data
                full_data = metadata.get('full_item_data', {})
                publisher = full_data.get('publisher', '')
                journal_name = metadata.get('journal', '')
                surname = (publisher or journal_name or 'unknown').lower()

            # Format author list
            if authors:
                author_parts = []
                for author in authors:
                    family = author.get('family', '')
                    given = author.get('given', '')
                    if family and given:
                        author_parts.append(f"{family}, {given}")
                    elif family:
                        author_parts.append(family)
                author_str = ' and '.join(author_parts)

            title = metadata['title']
            year = metadata['year']
            journal = metadata['journal']
            volume = metadata['volume']
            pages = metadata['pages']
            doi = metadata['doi']

            # Determine entry type
            entry_type = 'article' if journal or volume else 'misc'

            # Generate key if not already in citation_keys
            if not key:
                key = generate_citation_key(surname, year, title)
        else:
            # Fall back to regex parsing
            author_match = re.match(r'^([A-Za-z\-]+)', ref)
            surname = author_match.group(1).lower() if author_match else 'unknown'

            author_match = re.match(r'^(.+?)(?:\.\s+[A-Z]|(?=\s+\())', ref)
            author_str = author_match.group(1).strip() if author_match else ''

            year_match = re.search(r'\((\d{4})\)', ref)
            year = year_match.group(1) if year_match else '0000'

            if 'et al.' in ref:
                # Robustly extract text after 'et al.' (handle with or without trailing space)
                parts = ref.split('et al. ', 1)
                if len(parts) > 1:
                    after_et_al = parts[1]
                else:
                    parts = ref.split('et al.', 1)
                    after_et_al = parts[1].lstrip() if len(parts) > 1 else ''

                if after_et_al:
                    title_match = re.match(r'^(.+?)\.\s+[A-Z]', after_et_al)
                    if title_match:
                        title = title_match.group(1)
            elif author_str:
                after_author = ref[len(author_str):].strip().lstrip('.')
                title_match = re.match(r'^(.+?)(?:\.\s+[A-Z][a-z]+\s+\d+|(?=\s+\())', after_author)
                if title_match:
                    title = title_match.group(1).strip().rstrip('.')

            if title and year:
                after_title_idx = ref.find(title) + len(title)
                before_year_idx = ref.find(f'({year})')
                if after_title_idx < before_year_idx:
                    journal_text = ref[after_title_idx:before_year_idx].strip()
                    journal_match = re.match(r'^\.?\s*([A-Za-z\s]+)', journal_text)
                    if journal_match:
                        journal = journal_match.group(1).strip()

            vol_pages_match = re.search(r'(\d+),\s+([\d–\-e]+)', ref)
            if vol_pages_match:
                volume = vol_pages_match.group(1)
                pages = vol_pages_match.group(2)

            doi_match = re.search(r'doi:([\d\.\/]+)', ref)
            doi = doi_match.group(1) if doi_match else ''

            entry_type = 'article' if journal or volume else 'misc'

            # Generate key if not already set
            if not key:
                key = generate_citation_key(surname, year, title if title else ref)
        
        # Build BibTeX entry
        bib = f"@{entry_type}{{{key},\n"
        if author_str:
            bib += f"  author = {{{author_str}}},\n"
        if title:
            bib += f"  title = {{{{{title}}}}},\n"
        if journal:
            bib += f"  journal = {{{journal}}},\n"
        if volume:
            bib += f"  volume = {{{volume}}},\n"
        if pages:
            bib += f"  pages = {{{pages}}},\n"
        if year:
            bib += f"  year = {{{year}}},\n"
        if doi:
            bib += f"  doi = {{{doi}}},\n"
        if raw_zotero_data:
            zotero_json = json.dumps(raw_zotero_data)
            zotero_b64 = base64.b64encode(zotero_json.encode()).decode()
            bib += f"  zotero-data = {{{zotero_b64}}},\n"
        bib += "}\n"
        
        bibtex_entries.append(bib)
    
    return '\n'.join(bibtex_entries)

# ============================================================================
# MAIN CONVERSION PROCESS
# ============================================================================
# Multi-pass approach ensures citation keys are consistent between markdown
# and BibTeX, and prevents false positive citation conversions.

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 convert.py <input.docx>")
        sys.exit(1)

    docx_path = sys.argv[1]

    # Validate input file
    if not Path(docx_path).exists():
        print(f"Error: File not found: {docx_path}")
        sys.exit(1)

    if not zipfile.is_zipfile(docx_path):
        print(f"Error: Not a valid DOCX file: {docx_path}")
        sys.exit(1)

    base_name = Path(docx_path).stem

    # Step 1: Extract Zotero metadata and comments from Word file
    # Zotero stores complete bibliographic data in JSON within field codes
    # Comments contain reviewer feedback with author, date, and text
    zotero_metadata = extract_zotero_metadata(docx_path)
    comments = extract_comments(docx_path)

    # Step 2: Build citation key mapping using Zotero metadata
    # Maps citation numbers (1, 2, 3...) to pandoc keys (author2020title)
    # This mapping is built BEFORE processing the document text to ensure
    # consistency between markdown citations and BibTeX entries
    citation_keys = {}
    seen_keys = set()

    for cite_text, meta_list in zotero_metadata.items():
        # Parse citation text to handle ranges (3-5) and lists (1,2)
        cite_nums = []
        for part in cite_text.replace('–', '-').split(','):
            part = part.strip()
            if '-' in part:
                start, end = part.split('-', 1)
                if start.strip().isdigit() and end.strip().isdigit():
                    cite_nums.extend(range(int(start.strip()), int(end.strip()) + 1))
            elif part.isdigit():
                cite_nums.append(int(part))

        # Map each citation number to its metadata and generate key
        # Fallback hierarchy: author → publisher → journal → "unknown"
        for idx, num in enumerate(cite_nums):
            if idx < len(meta_list):
                meta = meta_list[idx]
                authors = meta['authors']

                # Use author, fallback to institution/publisher, then journal
                if authors and authors[0].get('family'):
                    surname = authors[0].get('family').lower()
                else:
                    # Check for institution/publisher in full_item_data
                    full_data = meta.get('full_item_data', {})
                    publisher = full_data.get('publisher', '')
                    journal = meta.get('journal', '')
                    surname = (publisher or journal or 'unknown').lower()

                year = meta['year']
                title = meta['title']

                # Generate key with deduplication (append numbers if collision)
                base_key = generate_citation_key(surname, year, title)
                key = base_key
                counter = 2
                while key in seen_keys:
                    key = f"{base_key}{counter}"
                    counter += 1
                seen_keys.add(key)
                citation_keys[str(num)] = key

    # Step 3: Extract document content and build markdown
    # Citations are converted DURING parsing, not via regex replacement
    # This ensures only actual Zotero citations are converted, preventing false positives
    # Regular numbers like "20 to 39" or "22 countries" are left unchanged
    content = extract_document_content(docx_path)
    markdown = build_markdown(content, comments, zotero_metadata, citation_keys)

    # Step 4: Extract references from "Sources" section and remove from markdown
    # References will be converted to BibTeX format separately
    refs = parse_references(markdown)
    markdown_lines = markdown.split('\n')
    sources_idx = next((i for i, line in enumerate(markdown_lines) if line.strip() == 'Sources'), -1)

    if sources_idx >= 0:
        markdown = '\n'.join(markdown_lines[:sources_idx]).rstrip()

    # Step 5: Write output files
    # Markdown contains pandoc citations and Critic Markup comments
    # BibTeX contains deduplicated entries with sanitized keys
    try:
        with open(f'{base_name}.md', 'w', encoding='utf-8') as f:
            f.write(markdown)
    except IOError as e:
        print(f"Error: Failed to write {base_name}.md: {e}")
        sys.exit(1)

    if refs:
        try:
            bibtex = convert_to_bibtex(refs, zotero_metadata, citation_keys)
            with open(f'{base_name}.bib', 'w', encoding='utf-8') as f:
                f.write(bibtex)
        except IOError as e:
            print(f"Error: Failed to write {base_name}.bib: {e}")
            sys.exit(1)

    print(f"✓ Created {base_name}.md with {len(comments)} comments")
    if refs:
        print(f"✓ Created {base_name}.bib with {len(refs)} references")

if __name__ == "__main__":
    main()
