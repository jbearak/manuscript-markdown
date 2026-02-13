"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Builds a synthetic .docx file for testing the converter.
 * Contains anonymized content with:
 * - 2 Zotero citations (one single, one multi-item)
 * - 3 Word comments
 * - Multiple paragraphs
 * Run: bun run test/fixtures/build-sample-docx.ts
 */
const jszip_1 = __importDefault(require("jszip"));
const fs_1 = require("fs");
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
// Zotero citation JSON payloads
const citation1JSON = JSON.stringify({
    citationID: 'test1',
    properties: { formattedCitation: '(Smith 2020)', plainCitation: '(Smith 2020)', noteIndex: 0 },
    citationItems: [{
            id: 1001,
            uris: ['http://zotero.org/users/0/items/AAAA1111'],
            itemData: {
                id: 1001, type: 'article-journal',
                title: 'Effects of climate on agriculture',
                'container-title': 'Journal of Testing',
                author: [{ family: 'Smith', given: 'Alice' }],
                issued: { 'date-parts': [[2020]] },
                volume: '10', page: '1-15',
                DOI: '10.1234/test.2020.001',
            },
        }],
});
const citation2JSON = JSON.stringify({
    citationID: 'test2',
    properties: { formattedCitation: '(Jones 2019; Smith 2020)', plainCitation: '(Jones 2019; Smith 2020)', noteIndex: 0 },
    citationItems: [
        {
            id: 1002,
            uris: ['http://zotero.org/users/0/items/BBBB2222'],
            itemData: {
                id: 1002, type: 'article-journal',
                title: 'Urban planning and public health',
                'container-title': 'Review of Studies',
                author: [{ family: 'Jones', given: 'Bob' }, { family: 'Lee', given: 'Carol' }],
                issued: { 'date-parts': [[2019]] },
                volume: '5', page: '100-120',
                DOI: '10.1234/test.2019.002',
            },
        },
        {
            id: 1001,
            uris: ['http://zotero.org/users/0/items/AAAA1111'],
            itemData: {
                id: 1001, type: 'article-journal',
                title: 'Effects of climate on agriculture',
                'container-title': 'Journal of Testing',
                author: [{ family: 'Smith', given: 'Alice' }],
                issued: { 'date-parts': [[2020]] },
                volume: '10', page: '1-15',
                DOI: '10.1234/test.2020.001',
            },
        },
    ],
});
function xmlHeader() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
}
function buildDocumentXml() {
    return `${xmlHeader()}
<w:document xmlns:w="${W}">
<w:body>
  <w:p>
    <w:commentRangeStart w:id="1"/>
    <w:r><w:t>Research on global trends has expanded significantly in recent years.</w:t></w:r>
    <w:commentRangeEnd w:id="1"/>
    <w:r><w:commentReference w:id="1"/></w:r>
    <w:r><w:t xml:space="preserve"> Several studies have examined these patterns </w:t></w:r>
    <w:r><w:fldChar w:fldCharType="begin"/></w:r>
    <w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ${citation1JSON}</w:instrText></w:r>
    <w:r><w:fldChar w:fldCharType="separate"/></w:r>
    <w:r><w:t>(Smith 2020)</w:t></w:r>
    <w:r><w:fldChar w:fldCharType="end"/></w:r>
    <w:r><w:t>.</w:t></w:r>
  </w:p>
  <w:p>
    <w:commentRangeStart w:id="2"/>
    <w:r><w:t>The methodology involved collecting data from multiple sources across different regions.</w:t></w:r>
    <w:commentRangeEnd w:id="2"/>
    <w:r><w:commentReference w:id="2"/></w:r>
  </w:p>
  <w:p>
    <w:commentRangeStart w:id="3"/>
    <w:r><w:t>Previous work has established a framework for analysis</w:t></w:r>
    <w:commentRangeEnd w:id="3"/>
    <w:r><w:commentReference w:id="3"/></w:r>
    <w:r><w:t xml:space="preserve"> </w:t></w:r>
    <w:r><w:fldChar w:fldCharType="begin"/></w:r>
    <w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ${citation2JSON}</w:instrText></w:r>
    <w:r><w:fldChar w:fldCharType="separate"/></w:r>
    <w:r><w:t>(Jones 2019; Smith 2020)</w:t></w:r>
    <w:r><w:fldChar w:fldCharType="end"/></w:r>
    <w:r><w:t>. Further investigation is needed.</w:t></w:r>
  </w:p>
  <w:p>
    <w:r><w:t>Sources</w:t></w:r>
  </w:p>
  <w:p>
    <w:r><w:t>1. Smith A. Effects of climate on agriculture. Journal of Testing 10, 1-15 (2020).</w:t></w:r>
  </w:p>
  <w:p>
    <w:r><w:t>2. Jones B, Lee C. Urban planning and public health. Review of Studies 5, 100-120 (2019).</w:t></w:r>
  </w:p>
</w:body>
</w:document>`;
}
function buildCommentsXml() {
    return `${xmlHeader()}
<w:comments xmlns:w="${W}">
  <w:comment w:id="1" w:author="Alice Reviewer" w:date="2025-01-15T10:30:00Z" w:initials="AR">
    <w:p><w:r><w:t>Consider adding more context about the scope of these trends.</w:t></w:r></w:p>
  </w:comment>
  <w:comment w:id="2" w:author="Bob Editor" w:date="2025-01-16T14:00:00Z" w:initials="BE">
    <w:p><w:r><w:t>Can you specify which regions were included?</w:t></w:r></w:p>
  </w:comment>
  <w:comment w:id="3" w:author="Alice Reviewer" w:date="2025-01-17T09:15:00Z" w:initials="AR">
    <w:p><w:r><w:t>This framework reference needs updating.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`;
}
function buildContentTypes() {
    return `${xmlHeader()}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
</Types>`;
}
function buildRels() {
    return `${xmlHeader()}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
}
function buildDocRels() {
    return `${xmlHeader()}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
</Relationships>`;
}
async function main() {
    const zip = new jszip_1.default();
    zip.file('[Content_Types].xml', buildContentTypes());
    zip.file('_rels/.rels', buildRels());
    zip.file('word/document.xml', buildDocumentXml());
    zip.file('word/comments.xml', buildCommentsXml());
    zip.file('word/_rels/document.xml.rels', buildDocRels());
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const path = require('path');
    const outPath = path.join(__dirname, 'sample.docx');
    (0, fs_1.writeFileSync)(outPath, buf);
    console.log(`Written ${outPath} (${buf.length} bytes)`);
}
main().catch(console.error);
//# sourceMappingURL=build-sample-docx.js.map