import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

function extractPlainText(md: string): string {
  return md
    .replace(/^#+\s*/gm, '')           // strip heading markers
    .replace(/^(> )+/gm, '')          // strip blockquote markers
    .replace(/^[-*]\s+/gm, '')         // strip bullet markers
    .replace(/^\d+\.\s+/gm, '')       // strip ordered list markers
    .replace(/\*\*([^*]+)\*\*/g, '$1') // strip bold
    .replace(/\*([^*]+)\*/g, '$1')     // strip italic
    .replace(/~~([^~]+)~~/g, '$1')     // strip strikethrough
    .replace(/`([^`]+)`/g, '$1')       // strip inline code
    .replace(/\n{2,}/g, '\n')          // collapse blank lines
    .trim();
}

const safeText = fc.array(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')),
  { minLength: 3, maxLength: 15 }
).map(arr => arr.join('').trim()).filter(s => s.length > 0);

const paragraphGen = safeText;
const headingGen = fc.tuple(fc.integer({ min: 1, max: 3 }), safeText)
  .map(([level, text]) => '#'.repeat(level) + ' ' + text);
const bulletGen = safeText.map(text => '- ' + text);
const orderedGen = safeText.map(text => '1. ' + text);
const boldGen = safeText.map(text => '**' + text + '**');
const blockquoteGen = safeText.map(text => '> ' + text);

const elementGen = fc.oneof(paragraphGen, headingGen, bulletGen, orderedGen, boldGen, blockquoteGen);
const documentGen = fc.array(elementGen, { minLength: 1, maxLength: 5 })
  .map(elements => elements.join('\n\n'));

describe('Feature: md-to-docx-conversion', () => {
  it('Property 15: Full MD→DOCX→MD round-trip', async () => {
    await fc.assert(
      fc.asyncProperty(documentGen, async (markdown) => {
        const docxResult = await convertMdToDocx(markdown);
        const mdResult = await convertDocx(docxResult.docx);
        
        const originalText = extractPlainText(markdown);
        const roundTripText = extractPlainText(mdResult.markdown);
        
        // Each word from the original should appear in the round-trip
        const originalWords = originalText.split(/\s+/).filter(w => w.length > 0);
        for (const word of originalWords) {
          expect(roundTripText).toContain(word);
        }
      }),
      { numRuns: 50 } // Fewer runs since async is slower
    );
  });
});