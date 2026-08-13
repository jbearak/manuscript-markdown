// Round-trip tests for headings inside full-paragraph CriticMarkup spans.
// {++### heading++} must export with the Heading paragraph style (paragraph
// mark carrying <w:ins>/<w:del>) and convert back to the same markdown form,
// distinct from ### {++heading++} (heading paragraph with inserted text runs).
import { describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

async function paragraphInfo(docx: Uint8Array): Promise<Array<{ style: string; text: string; ins: boolean; del: boolean; paraMarkIns: boolean; paraMarkDel: boolean }>> {
  const zip = await JSZip.loadAsync(docx);
  const doc = await zip.file('word/document.xml')!.async('string');
  const paras = doc.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
  return paras.map(p => {
    const pPr = p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] || '';
    return {
      style: p.match(/<w:pStyle w:val="([^"]+)"/)?.[1] || 'Normal',
      text: (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map(m => m.replace(/<[^>]+>/g, '')).join(''),
      ins: p.includes('<w:ins'),
      del: p.includes('<w:del'),
      paraMarkIns: /<w:rPr>[\s\S]*?<w:ins\b[\s\S]*?<\/w:rPr>/.test(pPr),
      paraMarkDel: /<w:rPr>[\s\S]*?<w:del\b[\s\S]*?<\/w:rPr>/.test(pPr),
    };
  });
}

async function roundTrip(md: string): Promise<string> {
  const { docx } = await convertMdToDocx(md);
  const rt = await convertDocx(docx);
  return stripFrontmatter(rt.markdown);
}

describe('headings inside CriticMarkup spans', () => {
  it('{++### heading++} exports with Heading3 style and inserted paragraph mark', async () => {
    const { docx } = await convertMdToDocx('{++### subsection heading++}\n');
    const paras = await paragraphInfo(docx);
    expect(paras).toHaveLength(1);
    expect(paras[0].style).toBe('Heading3');
    expect(paras[0].text).toBe('subsection heading');
    expect(paras[0].ins).toBe(true);
    expect(paras[0].paraMarkIns).toBe(true);
  });

  it('{--### heading--} exports with Heading3 style and deleted paragraph mark', async () => {
    const { docx } = await convertMdToDocx('{--### old heading--}\n');
    const paras = await paragraphInfo(docx);
    expect(paras).toHaveLength(1);
    expect(paras[0].style).toBe('Heading3');
    expect(paras[0].del).toBe(true);
    expect(paras[0].paraMarkDel).toBe(true);
  });

  it('### {++heading++} exports with Heading3 style and no paragraph-mark revision', async () => {
    const { docx } = await convertMdToDocx('### {++subsection heading++}\n');
    const paras = await paragraphInfo(docx);
    expect(paras).toHaveLength(1);
    expect(paras[0].style).toBe('Heading3');
    expect(paras[0].ins).toBe(true);
    expect(paras[0].paraMarkIns).toBe(false);
  });

  it('all six heading levels get the matching style', async () => {
    for (let level = 1; level <= 6; level++) {
      const { docx } = await convertMdToDocx('{++' + '#'.repeat(level) + ' heading++}\n');
      const paras = await paragraphInfo(docx);
      expect(paras[0].style).toBe('Heading' + level);
    }
  });

  it('round-trips {++### heading++} exactly', async () => {
    const md = '{++### subsection heading++}\n';
    expect(await roundTrip(md)).toBe(md);
  });

  it('round-trips {--### heading--} exactly', async () => {
    const md = '{--### old heading--}\n';
    expect(await roundTrip(md)).toBe(md);
  });

  it('round-trips ### {++heading++} exactly (marker outside span)', async () => {
    const md = '### {++subsection heading++}\n';
    expect(await roundTrip(md)).toBe(md);
  });

  it('round-trips a critic heading between body paragraphs', async () => {
    const md = 'before\n\n{++## new section++}\n\nafter\n';
    expect(await roundTrip(md)).toBe(md);
  });

  it('keeps author and date on the round-tripped span', async () => {
    const md = '{++### heading++}\n';
    const { docx } = await convertMdToDocx(md, { authorName: 'Reviewer' });
    const zip = await JSZip.loadAsync(docx);
    const doc = await zip.file('word/document.xml')!.async('string');
    expect(doc).toMatch(/<w:pPr><w:pStyle w:val="Heading3"\/><w:rPr><w:ins [^/]*w:author="Reviewer"[^/]*\/><\/w:rPr><\/w:pPr>/);
  });

  it('does not promote non-heading or partial-paragraph spans', async () => {
    for (const md of [
      '{++**not a heading**++}\n',
      'x {++### not full para++}\n',
      '{++###no-space++}\n',
      '{++### ++}\n',
    ]) {
      const { docx } = await convertMdToDocx(md);
      const paras = await paragraphInfo(docx);
      expect(paras[0].style).toBe('Normal');
      expect(await roundTrip(md)).toBe(md);
    }
  });

  it('does not promote substitutions (old/new could differ in level)', async () => {
    const md = '{~~### old~>### new~~}\n';
    const { docx } = await convertMdToDocx(md);
    const paras = await paragraphInfo(docx);
    expect(paras[0].style).toBe('Normal');
    expect(await roundTrip(md)).toBe(md);
  });

  it('leaves critic headings inside blockquotes and lists untouched', async () => {
    for (const md of ['> {++### x++}\n', '- {++### x++}\n']) {
      expect(await roundTrip(md)).toBe(md);
    }
  });

  it('empty revised heading paragraph does not leak its marker into the next paragraph', async () => {
    // Simulate Word state where the inserted heading paragraph has no runs
    // left (only the paragraph-mark w:ins survives): strip the inserted run
    // from a generated docx. The deferred marker must serialize as its own
    // {++### ++} span instead of prefixing the following body paragraph.
    const { docx } = await convertMdToDocx('{++### h++}\n\nbody text\n');
    const zip = await JSZip.loadAsync(docx);
    let doc = await zip.file('word/document.xml')!.async('string');
    doc = doc.replace(/<w:ins w:id="\d+"[^>]*><w:r><w:t>h<\/w:t><\/w:r><\/w:ins>/, '');
    expect(doc).toContain('<w:pStyle w:val="Heading3"/><w:rPr><w:ins'); // paragraph-mark revision still present
    zip.file('word/document.xml', doc);
    const edited = await zip.generateAsync({ type: 'uint8array' });
    const rt = await convertDocx(edited);
    const body = stripFrontmatter(rt.markdown);
    expect(body).toBe('{++### ++}\n\nbody text\n');
  });

  it('formatted payload keeps heading style and reaches a round-trip fixed point', async () => {
    const md = '{++### **bold** heading++}\n';
    const once = await roundTrip(md);
    const { docx } = await convertMdToDocx(once);
    const paras = await paragraphInfo(docx);
    expect(paras[0].style).toBe('Heading3');
    expect(paras[0].paraMarkIns).toBe(true);
    expect(await roundTrip(once)).toBe(once);
  });
});
