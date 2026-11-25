/** `manuscript-markdown zotero …`: push a bibliography to a Zotero
 *  collection from the command line, so a script or an agent can do what the
 *  extension's command does.
 *
 *  Writing needs a key only a person can grant, in a dialog in Zotero, so
 *  granting is its own step (`zotero authorize`), run once by a person; the
 *  key is kept per Zotero instance in ~/.manuscript-markdown, readable only
 *  by its owner.  A push that has no key fails at once with that
 *  instruction rather than waiting on a dialog nobody may be watching.  A dry
 *  run, and a push with nothing to write, need no key. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  authorizeZoteroLocalApi,
  fetchZoteroServerId,
  listZoteroCollections,
  listZoteroGroups,
  ZoteroLocalApiError,
  type ZoteroCollectionSummary,
  type ZoteroLibraryScope,
  type ZoteroLocalApiOptions,
} from './zotero-local-api';
import {
  applyZoteroPush,
  formatZoteroPushReport,
  prepareZoteroPush,
  ZOTERO_APP_NAME,
  zoteroPushSucceeded,
  type ZoteroKeyProvider,
} from './zotero-push-run';
import { describeZoteroLocalApiError } from './zotero-sync-ui';

const USAGE = `Usage:
  manuscript-markdown zotero push <file.bib> --collection <collection> [options]
  manuscript-markdown zotero collections [--library <library>]
  manuscript-markdown zotero authorize

push: add every entry of the bibliography to a Zotero collection. An entry
whose item is elsewhere in the library is added to the collection; one Zotero
lacks is created there. Zotero must be running, version 10 or later.

Options:
  --collection <collection>  The collection's key, its name, or its path ("Parent / Child")
  --library <library>        "user" for My Library (default), or a group's id
  --update                   Also change matched items' fields to the bibliography's
  --dry-run                  Print what would change and write nothing

authorize: ask Zotero for a key to write with. Choose "Always Allow" in the
dialog Zotero shows; the key is saved in ~/.manuscript-markdown.

The environment variable ZOTERO_LOCAL_API_KEY, when set, is used as the key.`;

export interface ZoteroCliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Where keys are saved; defaults to ~/.manuscript-markdown/zotero-keys.json. */
  readonly keyFile?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly api?: ZoteroLocalApiOptions;
}

function defaultKeyFile(): string {
  return path.join(os.homedir(), '.manuscript-markdown', 'zotero-keys.json');
}

function readKeys(file: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeKeys(file: string, keys: Record<string, string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

class UsageError extends Error {}

interface Flags {
  readonly positional: string[];
  readonly values: Map<string, string>;
  readonly switches: Set<string>;
}

function parseFlags(args: readonly string[], valued: readonly string[], switches: readonly string[]): Flags {
  const out: Flags = { positional: [], values: new Map(), switches: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valued.includes(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} requires a value`);
      out.values.set(arg, value);
      i++;
    } else if (switches.includes(arg)) {
      out.switches.add(arg);
    } else if (arg.startsWith('--')) {
      throw new UsageError(`Unknown option ${arg}`);
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

async function resolveLibrary(value: string | undefined, api: ZoteroLocalApiOptions): Promise<ZoteroLibraryScope> {
  if (value === undefined || value === 'user') return { type: 'user' };
  const groups = await listZoteroGroups(api);
  const byId = /^\d+$/.test(value) ? groups.find(g => g.groupId === Number(value)) : undefined;
  const byName = groups.filter(g => g.name === value);
  const group = byId ?? (byName.length === 1 ? byName[0] : undefined);
  if (group === undefined) {
    throw new UsageError(
      `No Zotero library "${value}". Libraries: user` + groups.map(g => `, ${g.groupId} (${g.name})`).join(''),
    );
  }
  return { type: 'group', groupId: group.groupId };
}

/** The collection a --collection value names: its key, its path, or a name
 *  only one collection has. */
export function resolveCollection(
  value: string,
  collections: readonly ZoteroCollectionSummary[],
): ZoteroCollectionSummary {
  const byKey = collections.find(c => c.key === value);
  if (byKey) return byKey;
  // Two collections can share a path, and then it names neither.
  const byPath = collections.filter(c => c.path === value);
  const named = byPath.length > 0 ? byPath : collections.filter(c => c.name === value);
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    throw new UsageError(
      `Several collections are named "${value}"; give its key or path:\n` +
        named.map(c => `  ${c.key}  ${c.path}`).join('\n'),
    );
  }
  throw new UsageError(`No collection "${value}". Run "manuscript-markdown zotero collections" to list them.`);
}

function cliKeyProvider(serverId: string, io: ZoteroCliIo): ZoteroKeyProvider {
  const file = io.keyFile ?? defaultKeyFile();
  const fromEnv = io.env?.ZOTERO_LOCAL_API_KEY;
  let refused = false;
  return {
    async get() {
      const key = refused ? undefined : fromEnv || readKeys(file)[serverId];
      if (key === undefined || key === '') {
        throw new ZoteroLocalApiError(
          'unauthorized',
          !refused
            ? 'No key to write to Zotero with. Run "manuscript-markdown zotero authorize" first.'
            : fromEnv
              ? 'Zotero refused the key in ZOTERO_LOCAL_API_KEY. Replace or unset it.'
              : 'Zotero refused the saved key. Run "manuscript-markdown zotero authorize" again.',
        );
      }
      return key;
    },
    async invalidate() {
      refused = true;
    },
  };
}

async function push(args: readonly string[], io: ZoteroCliIo): Promise<number> {
  const flags = parseFlags(args, ['--collection', '--library'], ['--update', '--dry-run']);
  const [bibPath, ...extra] = flags.positional;
  if (bibPath === undefined || extra.length > 0) throw new UsageError('Give one .bib file to push.');
  const collectionValue = flags.values.get('--collection');
  if (collectionValue === undefined) throw new UsageError('--collection is required.');
  const api = io.api ?? {};
  const bibBytes = fs.readFileSync(bibPath);
  const bibText = new TextDecoder().decode(bibBytes);
  // A byte that isn't UTF-8 would be read as U+FFFD and pushed as text.
  if (!Buffer.from(bibText, 'utf8').equals(bibBytes)) {
    io.err(`"${bibPath}" is not plain UTF-8 (it has a byte-order mark or bytes in another encoding). Save it as UTF-8; nothing was pushed.`);
    return 1;
  }
  const scope = await resolveLibrary(flags.values.get('--library'), api);
  const collection = resolveCollection(collectionValue, await listZoteroCollections(scope, api));
  const mode = flags.switches.has('--update') ? 'update' : 'add';
  const prepared = await prepareZoteroPush(scope, bibText, collection.key, mode, api);
  if (prepared === undefined) {
    io.err(`Could not safely parse "${bibPath}". Check it for unbalanced braces or a stray @.`);
    return 1;
  }
  if (flags.switches.has('--dry-run') || !prepared.plan.changed) {
    io.out(formatZoteroPushReport(prepared.plan, collection.path));
    if (flags.switches.has('--dry-run')) io.out('Dry run: nothing was written.');
    return 0;
  }
  const result = await applyZoteroPush(scope, prepared, cliKeyProvider(prepared.serverId, io), api);
  io.out(formatZoteroPushReport(prepared.plan, collection.path, result));
  return zoteroPushSucceeded(result) ? 0 : 1;
}

async function collections(args: readonly string[], io: ZoteroCliIo): Promise<number> {
  const flags = parseFlags(args, ['--library'], []);
  if (flags.positional.length > 0) throw new UsageError('collections takes no file.');
  const api = io.api ?? {};
  const scope = await resolveLibrary(flags.values.get('--library'), api);
  for (const c of await listZoteroCollections(scope, api)) io.out(`${c.key}  ${c.path}`);
  return 0;
}

async function authorize(args: readonly string[], io: ZoteroCliIo): Promise<number> {
  parseFlags(args, [], []);
  const api = io.api ?? {};
  io.err('Zotero is asking for permission. Choose "Always Allow" in the Zotero window.');
  // The Server ID names the Zotero the key belongs to; read it first, so
  // the key is never filed under an instance that did not issue it.
  const serverId = await fetchZoteroServerId(api);
  const { key, remember } = await authorizeZoteroLocalApi(ZOTERO_APP_NAME, serverId, api);
  if (!remember) {
    io.err('That key is good for one write only, so it was not saved. Run this again and choose "Always Allow".');
    return 1;
  }
  const file = io.keyFile ?? defaultKeyFile();
  writeKeys(file, { ...readKeys(file), [serverId]: key });
  io.out(`Saved the key in ${file}.`);
  return 0;
}

/** Run `zotero <command> …`; returns the exit code. */
export async function runZoteroCli(args: readonly string[], io: ZoteroCliIo): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case 'push':
        return await push(rest, io);
      case 'collections':
        return await collections(rest, io);
      case 'authorize':
        return await authorize(rest, io);
      case undefined:
      case '--help':
      case 'help':
        io.out(USAGE);
        return command === undefined ? 1 : 0;
      default:
        throw new UsageError(`Unknown command "zotero ${command}".`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      io.err('Run "manuscript-markdown zotero --help" for usage.');
      return 2;
    }
    if (error instanceof ZoteroLocalApiError) {
      io.err(
        error.kind === 'aborted' || error.kind === 'unauthorized' || error.kind === 'request-failed'
          ? error.message
          : describeZoteroLocalApiError(error.kind),
      );
      return 1;
    }
    throw error;
  }
}
