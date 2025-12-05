import { describe, it, expect } from 'bun:test';
import MarkdownIt from 'markdown-it';
import { criticmarkupPlugin } from './preview/criticmarkup-plugin';

// Helper function to escape HTML entities like markdown-it does
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// We'll test the regex pattern directly for navigation tests
const combinedPattern = /\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{\~\~([\s\S]*?)\~\~\}|\{>>([\s\S]*?)<<\}|\{==([\s\S]*?)==\}|\~\~([\s\S]*?)\~\~|<!--([\s\S]*?)-->/g;

// Helper function to find all pattern matches in text
function findAllPatterns(text: string): Array<{ start: number; end: number; matched: string }> {
  const matches: Array<{ start: number; end: number; matched: string }> = [];
  let match;
  
  // Reset regex state
  combinedPattern.lastIndex = 0;
  
  while ((match = combinedPattern.exec(text)) !== null) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      matched: match[0]
    });
  }
  
  return matches;
}

describe('Edge Case Unit Tests', () => {
  
  describe('Empty patterns with newlines', () => {
    it('should recognize empty addition pattern with newlines', () => {
      const input = '{++\n\n++}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe('{++\n\n++}');
    });

    it('should render empty addition pattern with newlines in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{++\n\n++}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-addition');
      expect(output).toContain('<ins');
    });

    it('should recognize empty deletion pattern with newlines', () => {
      const input = '{--\n\n--}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe('{--\n\n--}');
    });

    it('should render empty deletion pattern with newlines in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{--\n\n--}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-deletion');
      expect(output).toContain('<del');
    });

    it('should recognize empty comment pattern with newlines', () => {
      const input = '{>>\n\n<<}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe('{>>\n\n<<}');
    });

    it('should render empty comment pattern with newlines in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{>>\n\n<<}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-comment');
      expect(output).toContain('<span');
    });

    it('should recognize empty highlight pattern with newlines', () => {
      const input = '{==\n\n==}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe('{==\n\n==}');
    });

    it('should render empty highlight pattern with newlines in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{==\n\n==}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-highlight');
      expect(output).toContain('<mark');
    });

    it('should recognize empty substitution pattern with newlines', () => {
      const input = '{~~\n\n~>\n\n~~}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe('{~~\n\n~>\n\n~~}');
    });

    it('should render empty substitution pattern with newlines in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{~~\n\n~>\n\n~~}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-substitution');
      expect(output).toContain('<del');
      expect(output).toContain('<ins');
    });
  });

  describe('Patterns with only whitespace', () => {
    it('should recognize addition pattern with only whitespace', () => {
      const input = '{++   \n   ++}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe('{++   \n   ++}');
    });

    it('should render addition pattern with only whitespace in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{++   \n   ++}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-addition');
      expect(output).toContain('<ins');
    });

    it('should recognize deletion pattern with only whitespace', () => {
      const input = '{--   \n   --}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe('{--   \n   --}');
    });

    it('should render deletion pattern with only whitespace in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{--   \n   --}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-deletion');
      expect(output).toContain('<del');
    });

    it('should recognize comment pattern with only whitespace', () => {
      const input = '{>>   \n   <<}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe('{>>   \n   <<}');
    });

    it('should render comment pattern with only whitespace in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{>>   \n   <<}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-comment');
      expect(output).toContain('<span');
    });

    it('should recognize highlight pattern with only whitespace', () => {
      const input = '{==   \n   ==}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe('{==   \n   ==}');
    });

    it('should render highlight pattern with only whitespace in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{==   \n   ==}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-highlight');
      expect(output).toContain('<mark');
    });

    it('should recognize substitution pattern with only whitespace', () => {
      const input = '{~~   \n   ~>   \n   ~~}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe('{~~   \n   ~>   \n   ~~}');
    });

    it('should render substitution pattern with only whitespace in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{~~   \n   ~>   \n   ~~}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-substitution');
      expect(output).toContain('<del');
      expect(output).toContain('<ins');
    });
  });

  describe('Substitutions with multi-line old and new text', () => {
    it('should recognize substitution with multi-line old and new text', () => {
      const input = '{~~old line 1\nold line 2\nold line 3~>new line 1\nnew line 2\nnew line 3~~}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe(input);
    });

    it('should render substitution with multi-line old and new text in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{~~old line 1\nold line 2\nold line 3~>new line 1\nnew line 2\nnew line 3~~}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-substitution');
      expect(output).toContain('criticmarkup-deletion');
      expect(output).toContain('criticmarkup-addition');
      expect(output).toContain('old line 1');
      expect(output).toContain('old line 2');
      expect(output).toContain('old line 3');
      expect(output).toContain('new line 1');
      expect(output).toContain('new line 2');
      expect(output).toContain('new line 3');
    });

    it('should recognize substitution with different line counts', () => {
      const input = '{~~short~>much\nlonger\nreplacement\ntext~~}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe(input);
    });

    it('should render substitution with different line counts in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{~~short~>much\nlonger\nreplacement\ntext~~}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-substitution');
      expect(output).toContain('short');
      expect(output).toContain('much');
      expect(output).toContain('longer');
      expect(output).toContain('replacement');
      expect(output).toContain('text');
    });
  });

  describe('Patterns with empty lines at various positions', () => {
    it('should recognize addition with empty line at start', () => {
      const input = '{++\ntext after empty line++}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe(input);
    });

    it('should render addition with empty line at start in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{++\ntext after empty line++}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-addition');
      expect(output).toContain('text after empty line');
    });

    it('should recognize addition with empty line in middle', () => {
      const input = '{++first line\n\nthird line++}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe(input);
    });

    it('should render addition with empty line in middle in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{++first line\n\nthird line++}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-addition');
      expect(output).toContain('first line');
      expect(output).toContain('third line');
    });

    it('should recognize addition with empty line at end', () => {
      const input = '{++text before empty line\n++}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe(input);
    });

    it('should render addition with empty line at end in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{++text before empty line\n++}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-addition');
      expect(output).toContain('text before empty line');
    });

    it('should recognize deletion with multiple empty lines', () => {
      const input = '{--line 1\n\n\nline 4--}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe(input);
    });

    it('should render deletion with multiple empty lines in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{--line 1\n\n\nline 4--}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-deletion');
      expect(output).toContain('line 1');
      expect(output).toContain('line 4');
    });

    it('should recognize substitution with empty lines in old text', () => {
      const input = '{~~old line 1\n\nold line 3~>new text~~}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe(input);
    });

    it('should render substitution with empty lines in old text in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{~~old line 1\n\nold line 3~>new text~~}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-substitution');
      expect(output).toContain('old line 1');
      expect(output).toContain('old line 3');
      expect(output).toContain('new text');
    });

    it('should recognize substitution with empty lines in new text', () => {
      const input = '{~~old text~>new line 1\n\nnew line 3~~}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe(input);
    });

    it('should render substitution with empty lines in new text in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{~~old text~>new line 1\n\nnew line 3~~}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-substitution');
      expect(output).toContain('old text');
      expect(output).toContain('new line 1');
      expect(output).toContain('new line 3');
    });

    it('should recognize substitution with empty lines in both old and new text', () => {
      const input = '{~~old 1\n\nold 3~>new 1\n\nnew 3~~}';
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe(input);
    });

    it('should render substitution with empty lines in both old and new text in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const input = '{~~old 1\n\nold 3~>new 1\n\nnew 3~~}';
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-substitution');
      expect(output).toContain('old 1');
      expect(output).toContain('old 3');
      expect(output).toContain('new 1');
      expect(output).toContain('new 3');
    });
  });

  describe('Very long patterns (100+ lines)', () => {
    it('should recognize addition pattern with 100+ lines', () => {
      const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`);
      const text = lines.join('\n');
      const input = `{++${text}++}`;
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe(input);
    });

    it('should render addition pattern with 100+ lines in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`);
      const text = lines.join('\n');
      const input = `{++${text}++}`;
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-addition');
      expect(output).toContain('line 1');
      expect(output).toContain('line 60');
      expect(output).toContain('line 120');
    });

    it('should recognize deletion pattern with 100+ lines', () => {
      const lines = Array.from({ length: 150 }, (_, i) => `deleted line ${i + 1}`);
      const text = lines.join('\n');
      const input = `{--${text}--}`;
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe(input);
    });

    it('should render deletion pattern with 100+ lines in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const lines = Array.from({ length: 150 }, (_, i) => `deleted line ${i + 1}`);
      const text = lines.join('\n');
      const input = `{--${text}--}`;
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-deletion');
      expect(output).toContain('deleted line 1');
      expect(output).toContain('deleted line 75');
      expect(output).toContain('deleted line 150');
    });

    it('should recognize comment pattern with 100+ lines', () => {
      const lines = Array.from({ length: 110 }, (_, i) => `comment line ${i + 1}`);
      const text = lines.join('\n');
      const input = `{>>${text}<<}`;
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe(input);
    });

    it('should render comment pattern with 100+ lines in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const lines = Array.from({ length: 110 }, (_, i) => `comment line ${i + 1}`);
      const text = lines.join('\n');
      const input = `{>>${text}<<}`;
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-comment');
      expect(output).toContain('comment line 1');
      expect(output).toContain('comment line 55');
      expect(output).toContain('comment line 110');
    });

    it('should recognize highlight pattern with 100+ lines', () => {
      const lines = Array.from({ length: 130 }, (_, i) => `highlight line ${i + 1}`);
      const text = lines.join('\n');
      const input = `{==${text}==}`;
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe(input);
    });

    it('should render highlight pattern with 100+ lines in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const lines = Array.from({ length: 130 }, (_, i) => `highlight line ${i + 1}`);
      const text = lines.join('\n');
      const input = `{==${text}==}`;
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-highlight');
      expect(output).toContain('highlight line 1');
      expect(output).toContain('highlight line 65');
      expect(output).toContain('highlight line 130');
    });

    it('should recognize substitution pattern with 100+ lines in both old and new', () => {
      const oldLines = Array.from({ length: 105 }, (_, i) => `old line ${i + 1}`);
      const newLines = Array.from({ length: 115 }, (_, i) => `new line ${i + 1}`);
      const oldText = oldLines.join('\n');
      const newText = newLines.join('\n');
      const input = `{~~${oldText}~>${newText}~~}`;
      const matches = findAllPatterns(input);
      
      expect(matches.length).toBe(1);
      expect(matches[0].matched).toBe(input);
    });

    it('should render substitution pattern with 100+ lines in both old and new in preview', () => {
      const md = new MarkdownIt();
      md.use(criticmarkupPlugin);
      
      const oldLines = Array.from({ length: 105 }, (_, i) => `old line ${i + 1}`);
      const newLines = Array.from({ length: 115 }, (_, i) => `new line ${i + 1}`);
      const oldText = oldLines.join('\n');
      const newText = newLines.join('\n');
      const input = `{~~${oldText}~>${newText}~~}`;
      const output = md.render(input);
      
      expect(output).toContain('criticmarkup-substitution');
      expect(output).toContain('old line 1');
      expect(output).toContain('old line 105');
      expect(output).toContain('new line 1');
      expect(output).toContain('new line 115');
    });
  });
});
