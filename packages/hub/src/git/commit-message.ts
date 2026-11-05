/** A `Key: value` line as `git interpret-trailers` would read it (token, optional space, colon). */
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9_-]*\s*:/;

/** Drops control characters (keeps tab and newline) so user text cannot smuggle NULs or terminal escapes into a commit. */
const stripControl = (s: string): string => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\r/g, "");

/** A title is a single line: whitespace (including newlines) collapses to one space. */
export function sanitizeTitle(title: string): string {
	return stripControl(title).replace(/\s+/g, " ").trim();
}

/**
 * Free text for the body of a commit message. Trailer-looking lines at the end are removed, and any other `Key: value` line that
 * starts with a `Merge-Request` key is indented, so the only trailer block git can find is the fixed one the Hub appends.
 */
export function sanitizeDescription(description: string): string {
	const lines = stripControl(description)
		.split("\n")
		.map((l) => l.replace(/\s+$/, ""));
	while (lines.length > 0 && (lines[lines.length - 1] === "" || TRAILER_LINE.test(lines[lines.length - 1] as string))) lines.pop();
	return lines
		.map((l) => (/^merge-request\s*:/i.test(l) ? `  ${l}` : l))
		.join("\n")
		.trim();
}

/** Commit message of a merge: user text first, then one blank line and a fixed trailer block that user text can never reach. */
export function mergeCommitMessage(input: { branch: string; title: string; description: string; mergeRequestId: string }): string {
	const body = sanitizeDescription(input.description);
	const subject = `Merge ${sanitizeTitle(input.branch)}: ${sanitizeTitle(input.title)}`;
	return `${subject}${body ? `\n\n${body}` : ""}\n\nMerge-Request: ${input.mergeRequestId}\n`;
}
