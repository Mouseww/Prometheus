import { AppError } from "@prometheus/protocol";

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/**
 * A PI session file with its header pointed at a new session id and working directory. Every other line is kept as it
 * is, so the message tree (ids and parent links) survives. Throws `transcriptInvalid` when the text is not a PI session.
 */
export function retargetTranscript(content: string, id: string, cwd: string): string {
	if (typeof content !== "string" || !content.trim() || content.length > MAX_TRANSCRIPT_BYTES) throw new AppError("transcriptInvalid");
	const lines = content.split(/\r?\n/).filter((l) => l.trim());
	let header: Record<string, unknown>;
	try {
		header = JSON.parse(lines[0]!) as Record<string, unknown>;
		for (const line of lines.slice(1)) {
			const entry = JSON.parse(line) as unknown;
			if (typeof entry !== "object" || entry === null) throw new Error("not an object");
		}
	} catch {
		throw new AppError("transcriptInvalid");
	}
	if (typeof header !== "object" || header === null || header.type !== "session") throw new AppError("transcriptInvalid");
	const { parentSession: _dropped, ...rest } = header;
	return `${[JSON.stringify({ ...rest, id, cwd }), ...lines.slice(1)].join("\n")}\n`;
}
