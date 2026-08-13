import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import { FRONTMATTER_MENU_SETTINGS, frontmatterSettingCommand } from './frontmatter-settings';

describe('Toolbar Configuration Property-Based Tests', () => {
  
  // Helper to load package.json
  const loadPackageJson = () => {
    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  };

  // Helper to get Manuscript Markdown-related toolbar entries
  const getManuscriptMarkdownToolbarEntries = (packageJson: any) => {
    const editorTitleMenu = packageJson.contributes?.menus?.['editor/title'] || [];
    
    return editorTitleMenu.filter((entry: any) => {
      // Only include entries with the markdown-editor when clause
      if (entry.when !== 'editorLangId == markdown && !isInDiffEditor') {
        return false;
      }
      // Check if it's a Manuscript Markdown command
      if (entry.command && entry.command.startsWith('manuscript-markdown.')) {
        return true;
      }
      // Check if it's one of the Markdown toolbar submenus
      if (entry.submenu && (
        entry.submenu === 'markdown.annotations' ||
        entry.submenu === 'markdown.formatting' ||
        entry.submenu === 'markdown.exportDocx'
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
    it('should validate when clause for all Manuscript Markdown toolbar entries', () => {
      fc.assert(
        fc.property(
          fc.constant(loadPackageJson()),
          (packageJson) => {
            const toolbarEntries = getManuscriptMarkdownToolbarEntries(packageJson);
            
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
      const toolbarEntries = getManuscriptMarkdownToolbarEntries(packageJson);
      
      // Should have exactly 3 entries: formatting, annotations, and Word export
      expect(toolbarEntries.length).toBe(3);
      
      // Find each expected entry
      const formattingSubmenu = toolbarEntries.find((e: any) => e.submenu === 'markdown.formatting');
      const annotationsSubmenu = toolbarEntries.find((e: any) => e.submenu === 'markdown.annotations');
      const exportSubmenu = toolbarEntries.find((e: any) => e.submenu === 'markdown.exportDocx');
      
      expect(formattingSubmenu).toBeDefined();
      expect(annotationsSubmenu).toBeDefined();
      expect(exportSubmenu).toBeDefined();
      
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
   * The three Manuscript Markdown toolbar buttons should occupy a contiguous, high-order
   * block in the navigation group so built-in Markdown actions do not interleave with them.
   */
  describe('Property 2: Button grouping and ordering', () => {
    it('should validate navigation group and ordering for all Manuscript Markdown toolbar entries', () => {
      fc.assert(
        fc.property(
          fc.constant(loadPackageJson()),
          (packageJson) => {
            const toolbarEntries = getManuscriptMarkdownToolbarEntries(packageJson);
            
            // Verify all entries are in navigation group
            for (const entry of toolbarEntries) {
              expect(entry.group).toBeDefined();
              expect(entry.group).toMatch(/^navigation@\d+$/);
            }
            
            // Verify specific contiguous ordering
            const formattingSubmenu = toolbarEntries.find((e: any) => e.submenu === 'markdown.formatting');
            const annotationsSubmenu = toolbarEntries.find((e: any) => e.submenu === 'markdown.annotations');
            const exportSubmenu = toolbarEntries.find((e: any) => e.submenu === 'markdown.exportDocx');
            
            expect(formattingSubmenu?.group).toBe('navigation@100');
            expect(annotationsSubmenu?.group).toBe('navigation@101');
            expect(exportSubmenu?.group).toBe('navigation@102');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should verify buttons appear in correct order in the array', () => {
      const packageJson = loadPackageJson();
      const editorTitleMenu = packageJson.contributes?.menus?.['editor/title'] || [];
      
      // Find indices of our three entries
      const formattingIndex = editorTitleMenu.findIndex((e: any) => e.submenu === 'markdown.formatting');
      const annotationsIndex = editorTitleMenu.findIndex((e: any) => e.submenu === 'markdown.annotations');
      const exportIndex = editorTitleMenu.findIndex((e: any) => e.submenu === 'markdown.exportDocx');
      
      // All three should be found
      expect(formattingIndex).toBeGreaterThanOrEqual(0);
      expect(annotationsIndex).toBeGreaterThanOrEqual(0);
      expect(exportIndex).toBeGreaterThanOrEqual(0);
      
      // Verify they appear in order (array order should match logical order)
      expect(formattingIndex).toBeLessThan(annotationsIndex);
      expect(annotationsIndex).toBeLessThan(exportIndex);
    });

    it('should verify all buttons are in the same navigation group', () => {
      fc.assert(
        fc.property(
          fc.constant(loadPackageJson()),
          (packageJson) => {
            const toolbarEntries = getManuscriptMarkdownToolbarEntries(packageJson);
            
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

  describe('DOCX actions in remote workspaces', () => {
    it('hides Open in Word from DOCX menus when a remote host is active', () => {
      const packageJson = loadPackageJson();
      const expectedWhen = 'resourceExtname == .docx && !remoteName';
      const menuIds = ['docx.actions', 'explorer/context'];

      for (const menuId of menuIds) {
        const entries = packageJson.contributes?.menus?.[menuId] || [];
        const openInWord = entries.find(
          (entry: any) => entry.command === 'manuscript-markdown.openInWord'
        );

        expect(openInWord).toBeDefined();
        expect(openInWord.when).toBe(expectedWhen);
      }
    });
  });

  describe('Export to Word menu', () => {
    it('groups every YAML frontmatter setting into submenus', () => {
      const packageJson = loadPackageJson();
      const commands = packageJson.contributes?.commands || [];
      const exportMenu = packageJson.contributes?.menus?.['markdown.exportDocx'] || [];
      const menuIds: Record<string, string> = {
        document: 'markdown.frontmatter.document',
        typography: 'markdown.frontmatter.typography',
        tables: 'markdown.frontmatter.tables',
        citations: 'markdown.frontmatter.citations',
        code: 'markdown.frontmatter.code',
      };

      expect(
        exportMenu.filter((entry: any) => entry.submenu?.startsWith('markdown.frontmatter.'))
          .map((entry: any) => entry.submenu)
      ).toEqual(Object.values(menuIds));

      for (const setting of FRONTMATTER_MENU_SETTINGS) {
        const commandId = frontmatterSettingCommand(setting.key);
        const command = commands.find((entry: any) => entry.command === commandId);
        const submenu = packageJson.contributes?.menus?.[menuIds[setting.group]] || [];
        const menuEntry = submenu.find((entry: any) => entry.command === commandId);

        expect(command?.title).toBe(setting.label);
        expect(menuEntry?.when).toBe('editorLangId == markdown');
      }

      const allSettingEntries = Object.values(menuIds).flatMap(
        menuId => packageJson.contributes?.menus?.[menuId] || []
      );
      expect(allSettingEntries.length).toBe(FRONTMATTER_MENU_SETTINGS.length);

      expect(
        commands.some((entry: any) => entry.command === 'manuscript-markdown.setCitationStyle')
      ).toBe(true);
      expect(
        exportMenu.some((entry: any) => entry.command === 'manuscript-markdown.setCitationStyle')
      ).toBe(false);
    });
  });
});
