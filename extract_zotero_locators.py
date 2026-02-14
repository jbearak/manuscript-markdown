#!/usr/bin/env python3
import zipfile
import xml.etree.ElementTree as ET
import json
import html
import re
import sys

def extract_zotero_citations(docx_path):
    """Extract Zotero citations from a DOCX file and return those with locator fields."""
    citations_with_locators = []
    
    try:
        with zipfile.ZipFile(docx_path, 'r') as docx:
            # Read the main document XML
            document_xml = docx.read('word/document.xml').decode('utf-8')
            
            # Find all ADDIN ZOTERO_ITEM field codes
            zotero_pattern = r'ADDIN ZOTERO_ITEM CSL_CITATION\s+([^}]+})'
            matches = re.findall(zotero_pattern, document_xml)
            
            for match in matches:
                try:
                    # Decode HTML entities
                    decoded = html.unescape(match)
                    
                    # Parse JSON
                    citation_data = json.loads(decoded)
                    
                    # Check for citationItems with locator field
                    if 'citationItems' in citation_data:
                        for item in citation_data['citationItems']:
                            if 'locator' in item:
                                citations_with_locators.append({
                                    'file': docx_path,
                                    'locator': item['locator'],
                                    'full_item': item
                                })
                                
                except (json.JSONDecodeError, KeyError) as e:
                    continue
                    
    except Exception as e:
        print(f"Error processing {docx_path}: {e}")
    
    return citations_with_locators

def main():
    files = ['Full draft.docx', 'Revised Manuscript.docx']
    all_citations = []
    
    for file in files:
        print(f"\nProcessing {file}...")
        citations = extract_zotero_citations(file)
        all_citations.extend(citations)
        print(f"Found {len(citations)} citations with locator fields")
    
    print(f"\n=== ZOTERO CITATION LOCATOR EXAMPLES ===")
    print(f"Total citations with locators found: {len(all_citations)}")
    
    for i, citation in enumerate(all_citations[:10], 1):
        print(f"\n{i}. File: {citation['file']}")
        print(f"   Locator: '{citation['locator']}'")
        if 'label' in citation['full_item']:
            print(f"   Label: {citation['full_item']['label']}")
        if 'itemData' in citation['full_item'] and 'title' in citation['full_item']['itemData']:
            title = citation['full_item']['itemData']['title'][:60]
            print(f"   Title: {title}{'...' if len(citation['full_item']['itemData']['title']) > 60 else ''}")

if __name__ == "__main__":
    main()