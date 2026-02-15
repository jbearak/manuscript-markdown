#!/usr/bin/env bun
/**
 * Build script for creating native binaries.
 *
 * Usage:
 *   bun scripts/build-binary.ts binary   - Create native binaries for all platforms
 *   bun scripts/build-binary.ts current  - Create binary for current platform only
 */

import { $ } from 'bun';
import * as fs from 'fs';
import * as path from 'path';

interface BuildTarget {
    platform: 'darwin' | 'linux' | 'windows';
    arch: 'x64' | 'arm64';
    output_name: string;
}

export interface PlatformInfo {
    platform: 'darwin' | 'linux' | 'windows';
    arch: 'arm64' | 'x64';
    binary_name: string;
}

export function detect_platform(): PlatformInfo | undefined {
    const platform = process.platform === 'darwin' ? 'darwin'
        : process.platform === 'linux' ? 'linux'
        : process.platform === 'win32' ? 'windows'
        : undefined;

    const arch = process.arch === 'arm64' ? 'arm64'
        : process.arch === 'x64' ? 'x64'
        : undefined;

    if (!platform || !arch) {
        return undefined;
    }

    const binary_name = platform === 'windows'
        ? `manuscript-markdown-${platform}-${arch}.exe`
        : `manuscript-markdown-${platform}-${arch}`;

    return { platform, arch, binary_name };
}

const TARGETS: BuildTarget[] = [
    { platform: 'darwin', arch: 'arm64', output_name: 'manuscript-markdown-darwin-arm64' },
    { platform: 'darwin', arch: 'x64', output_name: 'manuscript-markdown-darwin-x64' },
    { platform: 'linux', arch: 'x64', output_name: 'manuscript-markdown-linux-x64' },
    { platform: 'linux', arch: 'arm64', output_name: 'manuscript-markdown-linux-arm64' },
    { platform: 'windows', arch: 'x64', output_name: 'manuscript-markdown-windows-x64.exe' },
    { platform: 'windows', arch: 'arm64', output_name: 'manuscript-markdown-windows-arm64.exe' },
];

const PATHS = {
    entry: 'src/cli.ts',
    bin: 'bin',
};

function ensure_dir(dir_path: string): void {
    if (!fs.existsSync(dir_path)) {
        fs.mkdirSync(dir_path, { recursive: true });
    }
}

async function build_binary(target: BuildTarget): Promise<void> {
    console.log(`Building binary for ${target.platform}-${target.arch}...`);

    ensure_dir(PATHS.bin);

    const output_path = path.join(PATHS.bin, target.output_name);
    const bun_target = `bun-${target.platform}-${target.arch}`;

    try {
        await $`bun build ${PATHS.entry} --compile --target=${bun_target} --outfile=${output_path} --minify`;
        console.log(`Binary created: ${output_path}`);
    } catch (error) {
        console.error(`Failed to build ${target.output_name}:`, error);
        throw error;
    }
}

async function build_all_binaries(): Promise<void> {
    console.log('Building binaries for all platforms...');
    const failed_targets: string[] = [];

    for (const target of TARGETS) {
        try {
            await build_binary(target);
        } catch (error) {
            console.error(`Skipping ${target.output_name} due to error:`, error);
            failed_targets.push(target.output_name);
        }
    }

    if (failed_targets.length > 0) {
        throw new Error(`Failed to build ${failed_targets.length}/${TARGETS.length} targets: ${failed_targets.join(', ')}`);
    }

    console.log('All binaries built successfully.');
}

async function build_current_binary(): Promise<void> {
    const platform_info = detect_platform();
    if (!platform_info) {
        console.error(`Unsupported platform: ${process.platform}-${process.arch}`);
        process.exit(1);
    }

    const target = TARGETS.find(t => t.platform === platform_info.platform && t.arch === platform_info.arch);
    if (!target) {
        console.error(`No build target for ${platform_info.platform}-${platform_info.arch}`);
        process.exit(1);
    }

    await build_binary(target);

    const output_path = path.join(PATHS.bin, target.output_name);
    console.log(`\nBinary ready at: ${path.resolve(output_path)}`);
}

function print_usage(): void {
    console.log(`
Usage: bun scripts/build-binary.ts <command>

Commands:
  binary   Create native binaries for all platforms (bin/)
  current  Create binary for current platform only

Examples:
  bun scripts/build-binary.ts binary
  bun scripts/build-binary.ts current
`.trim());
}

async function main(): Promise<void> {
    const command = process.argv[2];

    switch (command) {
        case 'binary':
            await build_all_binaries();
            break;
        case 'current':
            await build_current_binary();
            break;
        case '--help':
        case '-h':
            print_usage();
            break;
        default:
            if (command) {
                console.error(`Unknown command: ${command}`);
            }
            print_usage();
            process.exit(1);
    }
}

if (import.meta.main) {
    main().catch((error) => {
        console.error('Build failed:', error);
        process.exit(1);
    });
}
