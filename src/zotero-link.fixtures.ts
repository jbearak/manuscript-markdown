/** Shared fixtures for the Zotero-linking tests.
 *
 *  A group library, because that is the case the feature is built for: group
 *  URIs resolve for every member, so they are what a shared manuscript should
 *  carry. */
import type { ZoteroCatalogItem } from './zotero-link';
import type { BibtexSourceRange } from './bibtex-parser';

export const GROUP_URI_BASE = 'http://zotero.org/groups/2295646/items/';

/** A catalog item with a canonical group URI derived from its key. */
export function zoteroItem(
  key: string,
  extra: Omit<Partial<ZoteroCatalogItem>, 'key' | 'uri'> = {},
): ZoteroCatalogItem {
  return { key, uri: GROUP_URI_BASE + key, ...extra };
}

/** A minimal trusted source range for a decision fixture whose offsets are
 *  never dereferenced by the code under test. */
export function entryAt(key: string): BibtexSourceRange {
  return { key, start: 0, end: 1, keyStart: 0, keyEnd: 1, trusted: true };
}
