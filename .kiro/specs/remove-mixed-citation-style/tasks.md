# Tasks: Remove Mixed Citation Style Setting

## Task 1: Remove from Converter API and Extension Host
- [x] 1.1 Remove `mixedCitationStyle` property and its JSDoc comment from `MdToDocxOptions` interface in `src/md-to-docx.ts`
- [x] 1.2 Remove `mixedCitationStyle` reading and passing in `src/extension.ts` (the `config.get` call and the property in the `convertMdToDocx` options object)
- [x] 1.3 Remove the comment referencing `mixedCitationStyle` in `src/converter.ts` (line ~33: `configurable via mixedCitationStyle`)

## Task 2: Remove from CLI
- [x] 2.1 Remove `mixedCitationStyle` from `CliOptions` interface in `src/cli.ts`
- [x] 2.2 Remove `mixedCitationStyle: 'separate'` default from `parseArgs` options initialization in `src/cli.ts`
- [x] 2.3 Remove the `--mixed-citation-style` flag parsing block (the `else if` branch) from `parseArgs` in `src/cli.ts`
- [x] 2.4 Remove `--mixed-citation-style` line from `showHelp()` in `src/cli.ts`
- [x] 2.5 Remove `mixedCitationStyle: options.mixedCitationStyle` from the `convertMdToDocx` call in `runMdToDocx()` in `src/cli.ts`

## Task 3: Remove VS Code Setting Definition
- [x] 3.1 Remove the `manuscriptMarkdown.mixedCitationStyle` block from `contributes.configuration.properties` in `package.json`

## Task 4: Update Tests
- [x] 4.1 In `src/cli.test.ts` Property 2 test: remove the `fc.constantFrom('separate', 'unified')` generator, remove `--mixed-citation-style` from args construction, remove `mixedCitationStyle` from destructured params and assertion
- [x] 4.2 In `src/cli.test.ts` defaults test: remove `expect(result.mixedCitationStyle).toBe('separate')` assertion
- [x] 4.3 In `src/cli.test.ts`: remove the `parseArgs throws on invalid mixed citation style` test entirely
- [x] 4.4 In `src/cli.test.ts` missing values test: remove `'--mixed-citation-style'` from the `valueFlags` array
- [x] 4.5 In `src/csl-citations.test.ts`: remove `mixedCitationStyle: 'unified'` from the mixed group test options and update the test name to remove "regardless of mixedCitationStyle"

## Task 5: Update Documentation
- [x] 5.1 Remove the `mixedCitationStyle` row from the Citations table in `docs/configuration.md`
- [x] 5.2 In `docs/zotero-roundtrip.md`: remove the `### mixedCitationStyle setting` subsection (heading, description, and table), and update the Mixed Citations prose to state that mixed groups always produce unified output
- [x] 5.3 In `docs/converter.md`: remove the `mixedCitationStyle` reference from the Citations bullet point, replacing it with a statement that mixed groups always produce unified output

## Task 6: Verify
- [x] 6.1 Run `bun run compile` to confirm TypeScript compilation succeeds with no references to the removed property
- [x] 6.2 Run `bun test` to confirm all tests pass
