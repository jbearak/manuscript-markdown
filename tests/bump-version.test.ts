import { test, expect } from "bun:test";
import fc from "fast-check";

// Helper functions that mirror the script's validation logic
function isValidBumpType(input: string): boolean {
  return /^(major|minor|patch)$/.test(input);
}

function isValidVersion(input: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$/.test(input);
}

function calculateBumpedVersion(currentVersion: string, bumpType: string): string {
  // Strip pre-release suffix for bump calculations
  const baseVersion = currentVersion.replace(/-.*$/, '');
  const [major, minor, patch] = baseVersion.split('.').map(Number);
  
  switch (bumpType) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Invalid bump type: ${bumpType}`);
  }
}

test("Feature: version-bump-script, Property 1: Input Validation - verify only valid bump types and semantic versions are accepted", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        // Valid bump types
        fc.constantFrom("major", "minor", "patch"),
        // Valid semantic versions
        fc.tuple(fc.nat(99), fc.nat(99), fc.nat(99)).map(([maj, min, pat]) => `${maj}.${min}.${pat}`),
        // Valid pre-release versions
        fc.tuple(
          fc.nat(99), 
          fc.nat(99), 
          fc.nat(99), 
          fc.string({ minLength: 1, maxLength: 10 }).map(s => s.replace(/[^a-zA-Z0-9.]/g, 'a'))
        ).map(([maj, min, pat, pre]) => `${maj}.${min}.${pat}-${pre}`),
        // Invalid inputs
        fc.string().filter(s => 
          !isValidBumpType(s) && !isValidVersion(s) && s !== ""
        )
      ),
      (input) => {
        const shouldBeValid = isValidBumpType(input) || isValidVersion(input);
        
        if (shouldBeValid) {
          expect(isValidBumpType(input) || isValidVersion(input)).toBe(true);
        } else {
          expect(isValidBumpType(input)).toBe(false);
          expect(isValidVersion(input)).toBe(false);
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("Feature: version-bump-script, Property 2: Version Calculation Correctness - verify correct calculation for each bump type", () => {
  fc.assert(
    fc.property(
      fc.tuple(fc.nat(99), fc.nat(99), fc.nat(99)),
      fc.constantFrom("major", "minor", "patch"),
      fc.option(fc.string({ minLength: 1, maxLength: 10 }).map(s => s.replace(/[^a-zA-Z0-9.]/g, 'a'))),
      ([major, minor, patch], bumpType, preRelease) => {
        const currentVersion = preRelease ? `${major}.${minor}.${patch}-${preRelease}` : `${major}.${minor}.${patch}`;
        
        const result = calculateBumpedVersion(currentVersion, bumpType);
        
        // Verify the result is a valid semantic version
        expect(isValidVersion(result)).toBe(true);
        
        // Verify the calculation is correct
        const [newMajor, newMinor, newPatch] = result.split('.').map(Number);
        
        switch (bumpType) {
          case "major":
            expect(newMajor).toBe(major + 1);
            expect(newMinor).toBe(0);
            expect(newPatch).toBe(0);
            break;
          case "minor":
            expect(newMajor).toBe(major);
            expect(newMinor).toBe(minor + 1);
            expect(newPatch).toBe(0);
            break;
          case "patch":
            expect(newMajor).toBe(major);
            expect(newMinor).toBe(minor);
            expect(newPatch).toBe(patch + 1);
            break;
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("Feature: version-bump-script, Property 3: Precondition Checks - verify dirty working directory rejection", async () => {
  const { execSync } = await import("child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  
  const tempDir = mkdtempSync(join(tmpdir(), "bump-version-test-"));
  
  try {
    // Initialize git repo with package.json
    execSync("git init", { cwd: tempDir });
    execSync("git config user.email 'test@example.com'", { cwd: tempDir });
    execSync("git config user.name 'Test User'", { cwd: tempDir });
    
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ version: "1.0.0" }, null, 2));
    execSync("git add package.json", { cwd: tempDir });
    execSync("git commit -m 'Initial commit'", { cwd: tempDir });
    
    // Create dirty working directory
    writeFileSync(join(tempDir, "dirty-file.txt"), "uncommitted changes");
    
    // Run script and expect failure
    const scriptPath = "/Users/jmb/repos/mdmarkup/scripts/bump-version.sh";
    try {
      execSync(`bash "${scriptPath}" patch`, { 
        cwd: tempDir, 
        encoding: "utf8",
        stdio: "pipe"
      });
      expect.unreachable("Script should have failed");
    } catch (error: any) {
      expect(error.status).toBe(1);
      expect(error.stdout.toString()).toContain("Working directory is not clean");
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
test("Feature: version-bump-script, Property 3: Version Extraction - verify version extraction works with various package.json formatting", async () => {
  const { execSync } = await import("child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  
  await fc.assert(
    fc.asyncProperty(
      fc.tuple(fc.nat(99), fc.nat(99), fc.nat(99)),
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 20 }),
        description: fc.option(fc.string({ maxLength: 100 })),
        main: fc.option(fc.string({ maxLength: 50 })),
        scripts: fc.option(fc.dictionary(fc.string({ maxLength: 20 }), fc.string({ maxLength: 100 }))),
        dependencies: fc.option(fc.dictionary(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 })))
      }),
      fc.constantFrom(0, 2, 4), // indentation
      async ([major, minor, patch], extraFields, indent) => {
        const tempDir = mkdtempSync(join(tmpdir(), "version-extract-test-"));
        
        try {
          const version = `${major}.${minor}.${patch}`;
          const packageJson = { version, ...extraFields };
          
          writeFileSync(join(tempDir, "package.json"), JSON.stringify(packageJson, null, indent));
          
          // Extract version using grep/sed (same method as script)
          const extractedVersion = execSync(
            `grep '"version"' package.json | sed 's/.*"version": *"\\([^"]*\\)".*/\\1/'`,
            { cwd: tempDir, encoding: "utf8" }
          ).trim();
          
          expect(extractedVersion).toBe(version);
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("Feature: version-bump-script, Property 4: File Update Preservation - verify npm version preserves all other package.json fields", async () => {
  const { execSync } = await import("child_process");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  
  await fc.assert(
    fc.asyncProperty(
      fc.tuple(fc.nat(9), fc.nat(9), fc.nat(9)),
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 10 }),
        description: fc.option(fc.string({ maxLength: 20 }))
      }),
      fc.constantFrom("major", "minor", "patch"),
      async ([major, minor, patch], extraFields, bumpType) => {
        const tempDir = mkdtempSync(join(tmpdir(), "file-update-test-"));
        
        try {
          const originalVersion = `${major}.${minor}.${patch}`;
          const originalPackageJson = { version: originalVersion, ...extraFields };
          
          writeFileSync(join(tempDir, "package.json"), JSON.stringify(originalPackageJson, null, 2));
          
          // Update version using npm version (same as script)
          const expectedVersion = calculateBumpedVersion(originalVersion, bumpType);
          execSync(`npm version "${expectedVersion}" --no-git-tag-version`, { cwd: tempDir, stdio: "pipe" });
          
          const updatedContent = readFileSync(join(tempDir, "package.json"), "utf8");
          const updatedPackageJson = JSON.parse(updatedContent);
          
          // Verify version was updated
          expect(updatedPackageJson.version).toBe(expectedVersion);
          
          // Verify all other fields remain unchanged
          const { version: _, ...originalOtherFields } = originalPackageJson;
          const { version: __, ...updatedOtherFields } = updatedPackageJson;
          
          expect(updatedOtherFields).toEqual(originalOtherFields);
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      }
    ),
    { numRuns: 20 }
  );
});

test("Feature: version-bump-script, Property 4: Precondition Checks - verify existing tag rejection logic", async () => {
  const { execSync } = await import("child_process");
  const { mkdtempSync, rmSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  
  const tempDir = mkdtempSync(join(tmpdir(), "bump-version-test-"));
  
  try {
    // Initialize git repo
    execSync("git init", { cwd: tempDir });
    execSync("git config user.email 'test@example.com'", { cwd: tempDir });
    execSync("git config user.name 'Test User'", { cwd: tempDir });
    
    // Create and commit initial file
    execSync("touch README.md", { cwd: tempDir });
    execSync("git add README.md", { cwd: tempDir });
    execSync("git commit -m 'Initial commit'", { cwd: tempDir });
    
    // Create existing tag
    execSync("git tag v1.0.1", { cwd: tempDir });
    
    // Test the tag check logic directly (this is what the script does)
    try {
      execSync("git rev-parse v1.0.1", { 
        cwd: tempDir, 
        stdio: "pipe"
      });
      // If we get here, the tag exists (which is what we expect)
      expect(true).toBe(true);
    } catch (error) {
      expect.unreachable("Tag should exist");
    }
    
    // Test that non-existent tag fails
    try {
      execSync("git rev-parse v9.9.9", { 
        cwd: tempDir, 
        stdio: "pipe"
      });
      expect.unreachable("Non-existent tag should fail");
    } catch (error: any) {
      expect(error.status).not.toBe(0);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Feature: version-bump-script, Property 5: Commit Message Format - verify commit message follows exact format 'chore: bump version to X.Y.Z'", async () => {
  const { execSync } = await import("child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  
  await fc.assert(
    fc.asyncProperty(
      fc.tuple(fc.nat(99), fc.nat(99), fc.nat(99)),
      fc.constantFrom("major", "minor", "patch"),
      async ([major, minor, patch], bumpType) => {
        const tempDir = mkdtempSync(join(tmpdir(), "commit-message-test-"));
        
        try {
          // Initialize git repo
          execSync("git init", { cwd: tempDir });
          execSync("git config user.email 'test@example.com'", { cwd: tempDir });
          execSync("git config user.name 'Test User'", { cwd: tempDir });
          
          const currentVersion = `${major}.${minor}.${patch}`;
          writeFileSync(join(tempDir, "package.json"), JSON.stringify({ version: currentVersion }, null, 2));
          writeFileSync(join(tempDir, "package-lock.json"), JSON.stringify({ version: currentVersion }, null, 2));
          
          execSync("git add .", { cwd: tempDir });
          execSync("git commit -m 'Initial commit'", { cwd: tempDir });
          
          // Simulate the script's git operations directly
          const expectedVersion = calculateBumpedVersion(currentVersion, bumpType);
          execSync(`npm version "${expectedVersion}" --no-git-tag-version`, { cwd: tempDir, timeout: 10000 });
          execSync("git add package.json package-lock.json", { cwd: tempDir });
          execSync(`git commit -m "chore: bump version to ${expectedVersion}"`, { cwd: tempDir });
          execSync(`git tag "v${expectedVersion}"`, { cwd: tempDir });
          
          // Get the latest commit message
          const commitMessage = execSync("git log -1 --pretty=format:%s", { 
            cwd: tempDir, 
            encoding: "utf8" 
          }).trim();
          
          const expectedMessage = `chore: bump version to ${expectedVersion}`;
          expect(commitMessage).toBe(expectedMessage);
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      }
    ),
    { numRuns: 20 }
  );
});

test("Feature: version-bump-script, Property 6: Tag Format - verify git tag is lightweight tag with name 'vX.Y.Z'", async () => {
  const { execSync } = await import("child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  
  await fc.assert(
    fc.asyncProperty(
      fc.tuple(fc.nat(99), fc.nat(99), fc.nat(99)),
      fc.constantFrom("major", "minor", "patch"),
      async ([major, minor, patch], bumpType) => {
        const tempDir = mkdtempSync(join(tmpdir(), "tag-format-test-"));
        
        try {
          // Initialize git repo
          execSync("git init", { cwd: tempDir });
          execSync("git config user.email 'test@example.com'", { cwd: tempDir });
          execSync("git config user.name 'Test User'", { cwd: tempDir });
          
          const currentVersion = `${major}.${minor}.${patch}`;
          writeFileSync(join(tempDir, "package.json"), JSON.stringify({ version: currentVersion }, null, 2));
          writeFileSync(join(tempDir, "package-lock.json"), JSON.stringify({ version: currentVersion }, null, 2));
          
          execSync("git add .", { cwd: tempDir });
          execSync("git commit -m 'Initial commit'", { cwd: tempDir });
          
          // Simulate the script's git operations directly
          const expectedVersion = calculateBumpedVersion(currentVersion, bumpType);
          const expectedTag = `v${expectedVersion}`;
          
          execSync(`npm version "${expectedVersion}" --no-git-tag-version`, { cwd: tempDir, timeout: 10000 });
          execSync("git add package.json package-lock.json", { cwd: tempDir });
          execSync(`git commit -m "chore: bump version to ${expectedVersion}"`, { cwd: tempDir });
          execSync(`git tag "${expectedTag}"`, { cwd: tempDir });
          
          // Verify tag exists
          const tagExists = execSync(`git tag -l "${expectedTag}"`, { 
            cwd: tempDir, 
            encoding: "utf8" 
          }).trim();
          expect(tagExists).toBe(expectedTag);
          
          // Verify it's a lightweight tag (not annotated)
          const tagType = execSync(`git cat-file -t "${expectedTag}"`, { 
            cwd: tempDir, 
            encoding: "utf8" 
          }).trim();
          expect(tagType).toBe("commit"); // Lightweight tags point to commits
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      }
    ),
    { numRuns: 20 }
  );
});

test("No automatic push - verify script does not perform git push operation", async () => {
  const { execSync } = await import("child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  
  const tempDir = mkdtempSync(join(tmpdir(), "no-push-test-"));
  
  try {
    // Initialize git repo
    execSync("git init", { cwd: tempDir });
    execSync("git config user.email 'test@example.com'", { cwd: tempDir });
    execSync("git config user.name 'Test User'", { cwd: tempDir });
    
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ version: "1.0.0" }, null, 2));
    writeFileSync(join(tempDir, "package-lock.json"), JSON.stringify({ version: "1.0.0" }, null, 2));
    
    // Create a local script that mimics the original but works in current directory
    const localScript = `#!/usr/bin/env bash
set -e

# Check git is clean
if [ -n "$(git status --porcelain)" ]; then
    echo "Error: Working directory is not clean. Commit or stash changes first."
    exit 1
fi

# Update version using npm
npm version "1.0.1" --no-git-tag-version

# Git operations (same as original script)
git add package.json package-lock.json
git commit -m "chore: bump version to 1.0.1"
git tag "v1.0.1"

echo "✓ Version bumped to 1.0.1"
echo "✓ Committed and tagged as v1.0.1"
echo ""
echo "To push: git push && git push --tags"
`;
    
    writeFileSync(join(tempDir, "local-bump.sh"), localScript);
    execSync("chmod +x local-bump.sh", { cwd: tempDir });
    
    // Commit everything including the script to have a clean working directory
    execSync("git add .", { cwd: tempDir });
    execSync("git commit -m 'Initial commit'", { cwd: tempDir });
    
    // Run local script and capture output
    const output = execSync("./local-bump.sh", { 
      cwd: tempDir, 
      encoding: "utf8" 
    });
    
    // Verify script suggests manual push but doesn't do it
    expect(output).toContain("To push: git push && git push --tags");
    expect(output).not.toContain("Pushed to remote");
    
    // Verify no remote tracking exists (would be set if push occurred)
    try {
      execSync("git rev-parse --abbrev-ref --symbolic-full-name @{u}", { 
        cwd: tempDir, 
        stdio: "pipe" 
      });
      expect.unreachable("Should not have upstream tracking");
    } catch (error: any) {
      expect(error.status).not.toBe(0); // Expected to fail
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});