const fs = require('fs');
const { execSync } = require('child_process');

function extractZoteroCitations(docxPath) {
    try {
        // Extract document.xml
        const tempDir = `${docxPath.replace(/[^a-zA-Z0-9]/g, '_')}_temp`;
        execSync(`unzip -q "${docxPath}" -d ${tempDir}`);
        
        const documentXml = fs.readFileSync(`${tempDir}/word/document.xml`, 'utf8');
        
        // Find all ADDIN ZOTERO_ITEM patterns
        const pattern = /ADDIN ZOTERO_ITEM CSL_CITATION\s+(\{.*?\}(?:\})*)/g;
        const citations = [];
        let match;
        
        while ((match = pattern.exec(documentXml)) !== null) {
            try {
                // Decode HTML entities
                let jsonStr = match[1]
                    .replace(/&quot;/g, '"')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&amp;/g, '&');
                
                // Find the complete JSON by counting braces
                let braceCount = 0;
                let endIndex = 0;
                for (let i = 0; i < jsonStr.length; i++) {
                    if (jsonStr[i] === '{') braceCount++;
                    if (jsonStr[i] === '}') braceCount--;
                    if (braceCount === 0) {
                        endIndex = i + 1;
                        break;
                    }
                }
                
                jsonStr = jsonStr.substring(0, endIndex);
                const citation = JSON.parse(jsonStr);
                
                if (citation.citationItems) {
                    citation.citationItems.forEach(item => {
                        if (item.locator) {
                            citations.push({
                                file: docxPath,
                                locator: item.locator,
                                label: item.label || 'page',
                                title: item.itemData?.title || 'Unknown title',
                                fullItem: item
                            });
                        }
                    });
                }
            } catch (e) {
                // Skip malformed citations
            }
        }
        
        // Cleanup
        execSync(`rm -rf ${tempDir}`);
        return citations;
        
    } catch (error) {
        console.error(`Error processing ${docxPath}:`, error.message);
        return [];
    }
}

const files = ['Full draft.docx', 'Revised Manuscript.docx'];
let allCitations = [];

files.forEach(file => {
    console.log(`\nProcessing ${file}...`);
    const citations = extractZoteroCitations(file);
    allCitations = allCitations.concat(citations);
    console.log(`Found ${citations.length} citations with locator fields`);
});

console.log(`\n=== ZOTERO CITATION LOCATOR EXAMPLES ===`);
console.log(`Total citations with locators: ${allCitations.length}`);

allCitations.slice(0, 10).forEach((citation, i) => {
    console.log(`\n${i + 1}. File: ${citation.file}`);
    console.log(`   Locator: "${citation.locator}"`);
    console.log(`   Label: ${citation.label}`);
    console.log(`   Title: ${citation.title.substring(0, 60)}${citation.title.length > 60 ? '...' : ''}`);
});