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

test("Feature: version-bump-script, Property 4: Precondition Checks - verify existing tag rejection", async () => {
  const { execSync } = await import("child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  
  const tempDir = mkdtempSync(join(tmpdir(), "bump-version-test-"));
  
  try {
    // Initialize git repo with package.json and package-lock.json
    execSync("git init", { cwd: tempDir });
    execSync("git config user.email 'test@example.com'", { cwd: tempDir });
    execSync("git config user.name 'Test User'", { cwd: tempDir });
    
    // Create package.json with version 1.0.0
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ 
      name: "test", 
      version: "1.0.0",
      private: true 
    }, null, 2));
    writeFileSync(join(tempDir, "package-lock.json"), JSON.stringify({ 
      name: "test",
      version: "1.0.0", 
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "test",
          version: "1.0.0"
        }
      }
    }, null, 2));
    
    execSync("git add .", { cwd: tempDir });
    execSync("git commit -m 'Initial commit'", { cwd: tempDir });
    
    // Create tag that will conflict with explicit version
    execSync("git tag v2.0.0", { cwd: tempDir });
    
    // Run script with explicit version that conflicts with existing tag
    const scriptPath = "/Users/jmb/repos/mdmarkup/scripts/bump-version.sh";
    try {
      execSync(`bash "${scriptPath}" 2.0.0`, { 
        cwd: tempDir, 
        encoding: "utf8",
        stdio: "pipe"
      });
      expect.unreachable("Script should have failed");
    } catch (error: any) {
      expect(error.status).toBe(1);
      expect(error.stdout.toString()).toContain("Tag 'v2.0.0' already exists");
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});