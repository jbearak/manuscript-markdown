#!/usr/bin/env python3
import zipfile
import re
import json
import html
import sys

def extract_complete_json(text, start_pos):
    """Extract complete JSON object starting from a position, handling nested braces."""
    brace_count = 0
    i = start_pos
    
    # Find the opening brace
    while i < len(text) and text[i] != '{':
        i += 1
    
    if i >= len(text):
        return None, i
    
    start = i
    brace_count = 1
    i += 1
    
    while i < len(text) and brace_count > 0:
        if text[i] == '{':
            brace_count += 1
        elif text[i] == '}':
            brace_count -= 1
        i += 1
    
    if brace_count == 0:
        return text[start:i], i
    else:
        return None, i

def extract_zotero_citations_with_locators(docx_path):
    """Extract Zotero citations from DOCX and return those with locator fields."""
    citations_with_locators = []
    
    try:
        with zipfile.ZipFile(docx_path, 'r') as docx:
            document_xml = docx.read('word/document.xml').decode('utf-8')
            
            # Find all ADDIN ZOTERO_ITEM patterns
            pattern = r'ADDIN ZOTERO_ITEM CSL_CITATION\s+'
            matches = list(re.finditer(pattern, document_xml))
            
            for match in matches:
                start_pos = match.end()
                json_str, end_pos = extract_complete_json(document_xml, start_pos)
                
                if json_str:
                    try:
                        # Decode HTML entities
                        decoded = html.unescape(json_str)
                        
                        # Parse JSON
                        citation_data = json.loads(decoded)
                        
                        # Check for citationItems with locator field
                        if 'citationItems' in citation_data:
                            for item in citation_data['citationItems']:
                                if 'locator' in item and item['locator']:
                                    citations_with_locators.append({
                                        'file': docx_path,
                                        'citation_id': citation_data.get('citationID', 'unknown'),
                                        'locator': item['locator'],
                                        'label': item.get('label', 'page'),
                                        'item_id': item.get('id', 'unknown'),
                                        'title': item.get('itemData', {}).get('title', 'Unknown title')[:100],
                                        'author': item.get('itemData', {}).get('author', [{}])[0].get('family', 'Unknown') if item.get('itemData', {}).get('author') else 'Unknown'
                                    })
                                    
                    except (json.JSONDecodeError, KeyError, IndexError) as e:
                        print(f"Error parsing citation: {e}")
                        continue
                        
    except Exception as e:
        print(f"Error processing {docx_path}: {e}")
    
    return citations_with_locators

def main():
    files = ['Full draft.docx', 'Revised Manuscript.docx']
    all_citations = []
    
    for file in files:
        print(f"\nProcessing {file}...")
        citations = extract_zotero_citations_with_locators(file)
        all_citations.extend(citations)
        print(f"Found {len(citations)} citations with locator fields")
    
    print(f"\n{'='*60}")
    print(f"ZOTERO CITATION LOCATOR EXAMPLES")
    print(f"{'='*60}")
    print(f"Total citations with locators found: {len(all_citations)}")
    
    if not all_citations:
        print("\nNo citations with locator fields were found in either document.")
        print("This could mean:")
        print("1. The citations don't have page numbers or other locators")
        print("2. The locators are stored in a different format")
        print("3. The citations use a different citation style")
        return
    
    for i, citation in enumerate(all_citations[:10], 1):
        print(f"\n{i}. File: {citation['file']}")
        print(f"   Citation ID: {citation['citation_id']}")
        print(f"   Locator: '{citation['locator']}'")
        print(f"   Label: {citation['label']}")
        print(f"   Author: {citation['author']}")
        print(f"   Title: {citation['title']}...")
    
    if len(all_citations) > 10:
        print(f"\n... and {len(all_citations) - 10} more citations with locators")

if __name__ == "__main__":
    main()