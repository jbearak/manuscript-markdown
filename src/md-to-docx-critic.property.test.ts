import { describe, it } from 'bun:test';
import * as fc from 'fast-check';
import { 
  generateParagraph, 
  convertMdToDocx,
  type MdToken,
  type MdRun
} from './md-to-docx';

const createState = () => ({
  commentId: 0,
  comments: [],
  relationships: new Map(),
  nextRId: 1, rIdOffset: 3,
  warnings: [],
  hasList: false,
  hasComments: false
});

const shortText = fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z0-9\s]+$/.test(s) && s.trim().length > 0);
const xmlSafeAuthor = fc.string({ minLength: 1, maxLength: 10 }).filter(s => /^[a-zA-Z0-9]+$/.test(s));
const isoDate = fc.constantFrom(
  '2024-01-01T00:00:00Z',
  '2024-06-15T12:30:00Z',
  '2024-12-31T23:59:59Z'
);

describe('CriticMarkup revision elements', () => {
  it('Property 8: CriticMarkup revision elements', () => {
    fc.assert(fc.property(
      fc.record({
        addText: shortText,
        delText: shortText,
        oldText: shortText,
        newText: shortText,
        author: xmlSafeAuthor,
        date: isoDate
      }),
      (data) => {
        // Test addition
        const addRun: MdRun = {
          type: 'critic_add',
          text: data.addText,
          author: data.author,
          date: data.date
        };
        const addToken: MdToken = { type: 'paragraph', runs: [addRun] };
        const addState = createState();
        const addResult = generateParagraph(addToken, addState, { authorName: 'Default' });
        
        if (!addResult.includes('<w:ins')) return false;
        if (!addResult.includes(`w:author="${data.author}"`)) return false;
        if (!addResult.includes(`w:date="${data.date}"`)) return false;
        if (!addResult.includes(data.addText)) return false;
        
        // Test deletion
        const delRun: MdRun = {
          type: 'critic_del',
          text: data.delText,
          author: data.author,
          date: data.date
        };
        const delToken: MdToken = { type: 'paragraph', runs: [delRun] };
        const delState = createState();
        const delResult = generateParagraph(delToken, delState, { authorName: 'Default' });
        
        if (!delResult.includes('<w:del')) return false;
        if (!delResult.includes('<w:delText')) return false;
        if (!delResult.includes(`w:author="${data.author}"`)) return false;
        if (!delResult.includes(`w:date="${data.date}"`)) return false;
        if (!delResult.includes(data.delText)) return false;
        
        // Test substitution
        const subRun: MdRun = {
          type: 'critic_sub',
          text: data.oldText,
          newText: data.newText,
          author: data.author,
          date: data.date
        };
        const subToken: MdToken = { type: 'paragraph', runs: [subRun] };
        const subState = createState();
        const subResult = generateParagraph(subToken, subState, { authorName: 'Default' });
        
        if (!subResult.includes('<w:del')) return false;
        if (!subResult.includes('<w:ins')) return false;
        if (!subResult.includes('<w:delText')) return false;
        if (!subResult.includes(data.oldText)) return false;
        if (!subResult.includes(data.newText)) return false;
        
        const authorMatches = (subResult.match(new RegExp(`w:author="${data.author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g')) || []).length;
        if (authorMatches !== 2) return false; // Should appear in both del and ins
        
        const dateMatches = (subResult.match(new RegExp(`w:date="${data.date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g')) || []).length;
        if (dateMatches !== 2) return false; // Should appear in both del and ins
        
        return true;
      }
    ), { numRuns: 100 });
  });
});

describe('Comment ID consistency', () => {
  it('Property 9: Comment ID consistency', () => {
    fc.assert(fc.property(
      fc.array(
        fc.record({
          text: shortText,
          commentText: shortText,
          author: xmlSafeAuthor,
          date: isoDate
        }),
        { minLength: 1, maxLength: 5 }
      ),
      (comments) => {
        const runs: MdRun[] = comments.map(c => ({
          type: 'critic_comment',
          text: c.text,
          commentText: c.commentText,
          author: c.author,
          date: c.date
        }));
        
        const token: MdToken = { type: 'paragraph', runs };
        const state = createState();
        const result = generateParagraph(token, state, { authorName: 'Default' });
        
        // Check that each comment has a unique ID
        const commentIds = new Set<number>();
        for (const comment of state.comments) {
          if (commentIds.has(comment.id)) return false;
          commentIds.add(comment.id);
        }
        
        // Check that IDs are sequential starting from 0
        const expectedIds = Array.from({ length: comments.length }, (_, i) => i);
        const actualIds = state.comments.map(c => c.id).sort((a, b) => a - b);
        if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) return false;
        
        // Check that each ID appears in the document XML
        for (const id of commentIds) {
          if (!result.includes(`w:id="${id}"`)) return false;
          if (!result.includes(`<w:commentReference w:id="${id}"/>`)) return false;
        }
        
        // For comments with text, check range markers
        for (let i = 0; i < comments.length; i++) {
          if (comments[i].text.trim()) {
            if (!result.includes(`<w:commentRangeStart w:id="${i}"/>`)) return false;
            if (!result.includes(`<w:commentRangeEnd w:id="${i}"/>`)) return false;
          }
        }
        
        // Check that hasComments flag is set
        if (!state.hasComments) return false;
        
        return true;
      }
    ), { numRuns: 100 });
  });
});