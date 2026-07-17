import * as vscode from 'vscode';
import * as os from 'os';

/**
 * Retrieves the author name for comment attribution
 * Returns null if disabled or unavailable
 * Always returns synchronously - never blocks
 *
 * Priority order:
 * 1. Check manuscriptMarkdown.includeAuthorNameInComments - if false, return null
 * 2. Check manuscriptMarkdown.authorName - if set, return this value
 * 3. Fallback to OS username from os.userInfo()
 * 4. Return null if all methods fail
 *
 * Preview/LSP invariants: authorName falls back to the OS
 * username, and timestamps must be ISO-8601 (local time) so docx round-trips
 * stay stable across locales.
 */
export function getAuthorName(): string | null {
	try {
		// Get configuration
		const config = vscode.workspace.getConfiguration('manuscriptMarkdown');
		
		// Priority 1: Check include setting
		const includeAuthorName = config.get<boolean>('includeAuthorNameInComments', true);
		if (!includeAuthorName) {
			return null;
		}
		
		// Priority 2: Check author name setting
		const authorName = config.get<string>('authorName', '');
		if (authorName && authorName.trim() !== '') {
			return authorName;
		}
		
		// Priority 3: Fallback to OS username
		try {
			const userInfo = os.userInfo();
			if (userInfo.username && userInfo.username.trim() !== '') {
				return userInfo.username;
			}
		} catch {
			// Ignore errors
		}
		
		// Priority 4: All methods failed, return null
		return null;
	} catch {
		// Fail fast - any error results in null
		return null;
	}
}

/**
 * Formats the author name with optional timestamp
 * Returns the formatted string or null if author name is unavailable
 * Format: "username (yyyy-mm-dd hh:mm)" or just "username" if timestamps disabled
 */
export function getFormattedAuthorName(): string | null {
	const authorName = getAuthorName();
	if (!authorName) {
		return null;
	}
	
	try {
		const config = vscode.workspace.getConfiguration('manuscriptMarkdown');
		const includeTimestamp = config.get<boolean>('includeTimestampInComments', true);
		
		if (!includeTimestamp) {
			return authorName;
		}
		
		// Format timestamp as local ISO 8601 without seconds to keep comment IDs stable
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, '0');
		const day = String(now.getDate()).padStart(2, '0');
		const hours = String(now.getHours()).padStart(2, '0');
		const minutes = String(now.getMinutes()).padStart(2, '0');
		
		const timestamp = `${year}-${month}-${day} ${hours}:${minutes}`;
		return `${authorName} (${timestamp})`;
	} catch {
		// If timestamp formatting fails, return just the author name
		return authorName;
	}
}
