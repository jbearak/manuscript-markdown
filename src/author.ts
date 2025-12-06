import * as vscode from 'vscode';
import * as os from 'os';

/**
 * Retrieves the author name for comment attribution
 * Returns null if disabled or unavailable
 * Always returns synchronously - never blocks
 * 
 * Priority order:
 * 1. Check criticmarkup.disableAuthorNames - if true, return null
 * 2. Check criticmarkup.authorName - if set, return this value
 * 3. Fallback to OS username from os.userInfo()
 * 4. Return null if all methods fail
 */
export function getAuthorName(): string | null {
	try {
		// Get configuration
		const config = vscode.workspace.getConfiguration('criticmarkup');
		
		// Priority 1: Check disable setting
		const disableAuthorNames = config.get<boolean>('disableAuthorNames', false);
		if (disableAuthorNames) {
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
	} catch (error) {
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
		const config = vscode.workspace.getConfiguration('criticmarkup');
		const includeTimestamp = config.get<boolean>('includeTimestampInComments', true);
		
		if (!includeTimestamp) {
			return authorName;
		}
		
		// Format timestamp as yyyy-mm-dd hh:mm in local timezone
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, '0');
		const day = String(now.getDate()).padStart(2, '0');
		const hours = String(now.getHours()).padStart(2, '0');
		const minutes = String(now.getMinutes()).padStart(2, '0');
		
		const timestamp = `${year}-${month}-${day} ${hours}:${minutes}`;
		return `${authorName} (${timestamp})`;
	} catch (error) {
		// If timestamp formatting fails, return just the author name
		return authorName;
	}
}
