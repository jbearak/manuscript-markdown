import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';

describe('Toolbar Configuration Property-Based Tests', () => {
  
  // Helper to load package.json
  const loadPackageJson = () => {
    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  };

  // Helper to get mdmarkup-related toolbar entries
  const getmdmarkupToolbarEntries = (packageJson: any) => {
    const editorTitleMenu = packageJson.contributes?.menus?.['editor/title'] || [];
    
    return editorTitleMenu.filter((entry: any) => {
      // Check if it's a mdmarkup command
      if (entry.command && entry.command.startsWith('mdmarkup.')) {
        return true;
      }
      // Check if it's a markdown submenu (annotations or formatting)
      if (entry.submenu && (
        entry.submenu === 'markdown.annotations' || 
        entry.submenu === 'markdown.formatting'
      )) {
        return true;
      }
      return false;
    });
  };

  /**
   * Feature: editor-toolbar-buttons, Property 1: Toolbar button visibility configuration
   * Validates: Requirements 1.1, 1.3, 1.4, 2.1, 2.3, 2.4
   * 
   * For any toolbar button entry in the editor/title menu, the when clause should be
   * editorLangId == markdown && !isInDiffEditor to ensure buttons appear only in
   * markdown files outside diff editor mode.
   */
  describe('Property 1: Toolbar button visibility configuration', () => {
    it('should validate when clause for all mdmarkup toolbar entries', () => {
      fc.assert(
        fc.property(
          fc.constant(loadPackageJson()),
          (packageJson) => {
            const toolbarEntries = getmdmarkupToolbarEntries(packageJson);
            
            // Verify we found the expected entries
            expect(toolbarEntries.length).toBeGreaterThan(0);
            
            // Check each entry has the correct when clause
            for (const entry of toolbarEntries) {
              expect(entry.when).toBeDefined();
              expect(entry.when).toBe('editorLangId == markdown && !isInDiffEditor');
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should verify all expected toolbar entries exist with correct when clauses', () => {
      const packageJson = loadPackageJson();
      const toolbarEntries = getmdmarkupToolbarEntries(packageJson);
      
      // Should have exactly 2 entries: 2 submenus (prevChange and nextChange are in the annotations submenu)
      expect(toolbarEntries.length).toBe(2);
      
      // Find each expected entry
      const formattingSubmenu = toolbarEntries.find((e: any) => e.submenu === 'markdown.formatting');
      const annotationsSubmenu = toolbarEntries.find((e: any) => e.submenu === 'markdown.annotations');
      
      expect(formattingSubmenu).toBeDefined();
      expect(annotationsSubmenu).toBeDefined();
      
      // Verify when clauses
      const expectedWhen = 'editorLangId == markdown && !isInDiffEditor';
      expect(formattingSubmenu.when).toBe(expectedWhen);
      expect(annotationsSubmenu.when).toBe(expectedWhen);
    });
  });

  /**
   * Feature: editor-toolbar-buttons, Property 2: Button grouping and ordering
   * Validates: Requirements 3.1, 3.2
   * 
   * For the two mdmarkup toolbar buttons (formatting submenu, annotations submenu),
   * they should be in the navigation group and ordered as: formatting (@1), annotations (@2)
   */
  describe('Property 2: Button grouping and ordering', () => {
    it('should validate navigation group and ordering for all mdmarkup toolbar entries', () => {
      fc.assert(
        fc.property(
          fc.constant(loadPackageJson()),
          (packageJson) => {
            const toolbarEntries = getmdmarkupToolbarEntries(packageJson);
            
            // Verify all entries are in navigation group
            for (const entry of toolbarEntries) {
              expect(entry.group).toBeDefined();
              expect(entry.group).toMatch(/^navigation@\d+$/);
            }
            
            // Verify specific ordering
            const formattingSubmenu = toolbarEntries.find((e: any) => e.submenu === 'markdown.formatting');
            const annotationsSubmenu = toolbarEntries.find((e: any) => e.submenu === 'markdown.annotations');
            
            expect(formattingSubmenu?.group).toBe('navigation@1');
            expect(annotationsSubmenu?.group).toBe('navigation@2');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should verify buttons appear in correct order in the array', () => {
      const packageJson = loadPackageJson();
      const editorTitleMenu = packageJson.contributes?.menus?.['editor/title'] || [];
      
      // Find indices of our two entries
      const formattingIndex = editorTitleMenu.findIndex((e: any) => e.submenu === 'markdown.formatting');
      const annotationsIndex = editorTitleMenu.findIndex((e: any) => e.submenu === 'markdown.annotations');
      
      // Both should be found
      expect(formattingIndex).toBeGreaterThanOrEqual(0);
      expect(annotationsIndex).toBeGreaterThanOrEqual(0);
      
      // Verify they appear in order (array order should match logical order)
      expect(formattingIndex).toBeLessThan(annotationsIndex);
    });

    it('should verify all buttons are in the same navigation group', () => {
      fc.assert(
        fc.property(
          fc.constant(loadPackageJson()),
          (packageJson) => {
            const toolbarEntries = getmdmarkupToolbarEntries(packageJson);
            
            // Extract group names (without @suffix)
            const groups = toolbarEntries.map((e: any) => {
              const match = e.group?.match(/^([^@]+)/);
              return match ? match[1] : null;
            });
            
            // All should be in 'navigation' group
            for (const group of groups) {
              expect(group).toBe('navigation');
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
