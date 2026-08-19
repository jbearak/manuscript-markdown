/** Shared fixtures for the Zotero-linking tests.
 *
 *  A group library, because that is the case the feature is built for: group
 *  URIs resolve for every member, so they are what a shared manuscript should
 *  carry. */
import type { ZoteroCatalogItem } from './zotero-link';

export const GROUP_URI_BASE = 'http://zotero.org/groups/2295646/items/';

/** A catalog item with a canonical group URI derived from its key. */
export function zoteroItem(
  key: string,
  extra: Omit<Partial<ZoteroCatalogItem>, 'key' | 'uri'> = {},
): ZoteroCatalogItem {
  return { key, uri: GROUP_URI_BASE + key, ...extra };
}
