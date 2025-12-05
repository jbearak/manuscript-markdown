import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Validates: Requirements 6.3
describe('CriticMarkup CSS Default Colors', () => {
  const cssPath = join(__dirname, 'criticmarkup.css');
  const cssContent = readFileSync(cssPath, 'utf-8');

  it('should contain green color for additions', () => {
    expect(cssContent).toContain('.criticmarkup-addition');
    expect(cssContent).toMatch(/\.criticmarkup-addition[\s\S]*?color:\s*#00bb00/);
  });

  it('should contain red color for deletions', () => {
    expect(cssContent).toContain('.criticmarkup-deletion');
    expect(cssContent).toMatch(/\.criticmarkup-deletion[\s\S]*?color:\s*#dd0000/);
  });

  it('should contain orange color for substitutions', () => {
    expect(cssContent).toContain('.criticmarkup-substitution');
    expect(cssContent).toMatch(/\.criticmarkup-substitution[\s\S]*?color:\s*#ff8600/);
  });

  it('should contain blue color for comments', () => {
    expect(cssContent).toContain('.criticmarkup-comment');
    expect(cssContent).toMatch(/\.criticmarkup-comment[\s\S]*?color:\s*#4a9eff/);
  });

  it('should contain purple color for highlights', () => {
    expect(cssContent).toContain('.criticmarkup-highlight');
    expect(cssContent).toMatch(/\.criticmarkup-highlight[\s\S]*?color:\s*#aa53a9/);
  });

  it('should contain semi-transparent backgrounds for all types', () => {
    // Addition background
    expect(cssContent).toMatch(/\.criticmarkup-addition[\s\S]*?background-color:\s*rgba\(0,\s*187,\s*0,\s*0\.1\)/);
    
    // Deletion background
    expect(cssContent).toMatch(/\.criticmarkup-deletion[\s\S]*?background-color:\s*rgba\(221,\s*0,\s*0,\s*0\.1\)/);
    
    // Substitution background
    expect(cssContent).toMatch(/\.criticmarkup-substitution[\s\S]*?background-color:\s*rgba\(255,\s*134,\s*0,\s*0\.1\)/);
    
    // Comment background
    expect(cssContent).toMatch(/\.criticmarkup-comment[\s\S]*?background-color:\s*rgba\(74,\s*158,\s*255,\s*0\.15\)/);
    
    // Highlight background (slightly more opaque at 0.2)
    expect(cssContent).toMatch(/\.criticmarkup-highlight[\s\S]*?background-color:\s*rgba\(170,\s*83,\s*169,\s*0\.2\)/);
  });

  it('should contain strikethrough for deletions', () => {
    expect(cssContent).toMatch(/\.criticmarkup-deletion[\s\S]*?text-decoration:\s*line-through/);
  });

  it('should contain italic style for comments', () => {
    expect(cssContent).toMatch(/\.criticmarkup-comment[\s\S]*?font-style:\s*italic/);
  });
});
