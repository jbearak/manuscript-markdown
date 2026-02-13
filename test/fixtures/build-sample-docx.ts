/**
 * Builds a synthetic .docx file for testing the converter.
 * Contains anonymized content with:
 * - 2 Zotero citations (one single, one multi-item)
 * - 3 Word comments
 * - Multiple paragraphs
 * Run: bun run test/fixtures/build-sample-docx.ts
 */
import JSZip from 'jszip';
import { writeFileSync } from 'fs';

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

// Third citation: will be split across multiple w:instrText elements
const citation3JSON = JSON.stringify({
  citationID: 'test3',
  properties: { formattedCitation: '(Davis 2021)', plainCitation: '(Davis 2021)', noteIndex: 0 },
  citationItems: [{
    id: 1003,
    uris: ['http://zotero.org/users/0/items/CCCC3333'],
    itemData: {
      id: 1003, type: 'article-journal',
      title: 'Advances in renewable energy systems',
      'container-title': 'Energy Research Letters',
      author: [{ family: 'Davis', given: 'Eve' }],
      issued: { 'date-parts': [[2021]] },
      volume: '3', page: '45-60',
      DOI: '10.1234/test.2021.003',
    },
  }],
});

// Split the citation3 instrText prefix and JSON across multiple runs
const citation3Full = ` ADDIN ZOTERO_ITEM CSL_CITATION ${citation3JSON}`;
const citation3Split1 = citation3Full.slice(0, Math.floor(citation3Full.length / 3));
const citation3Split2 = citation3Full.slice(Math.floor(citation3Full.length / 3), Math.floor(2 * citation3Full.length / 3));
const citation3Split3 = citation3Full.slice(Math.floor(2 * citation3Full.length / 3));

function xmlHeader(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
}

function buildDocumentXml(): string {
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
    <w:r><w:t xml:space="preserve">Recent developments in energy policy have also been documented </w:t></w:r>
    <w:r><w:fldChar w:fldCharType="begin"/></w:r>
    <w:r><w:instrText>${citation3Split1}</w:instrText></w:r>
    <w:r><w:instrText>${citation3Split2}</w:instrText></w:r>
    <w:r><w:instrText>${citation3Split3}</w:instrText></w:r>
    <w:r><w:fldChar w:fldCharType="separate"/></w:r>
    <w:r><w:t>(Davis 2021)</w:t></w:r>
    <w:r><w:fldChar w:fldCharType="end"/></w:r>
    <w:r><w:t>.</w:t></w:r>
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
  <w:p>
    <w:r><w:t>3. Davis E. Advances in renewable energy systems. Energy Research Letters 3, 45-60 (2021).</w:t></w:r>
  </w:p>
</w:body>
</w:document>`;
}

function buildCommentsXml(): string {
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

function buildContentTypes(): string {
  return `${xmlHeader()}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
</Types>`;
}

function buildRels(): string {
  return `${xmlHeader()}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
}

function buildDocRels(): string {
  return `${xmlHeader()}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
</Relationships>`;
}

async function main() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', buildContentTypes());
  zip.file('_rels/.rels', buildRels());
  zip.file('word/document.xml', buildDocumentXml());
  zip.file('word/comments.xml', buildCommentsXml());
  zip.file('word/_rels/document.xml.rels', buildDocRels());

  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const outPath = new URL('sample.docx', import.meta.url).pathname;
  writeFileSync(outPath, buf);
  console.log(`Written ${outPath} (${buf.length} bytes)`);
}

main().catch(console.error);
