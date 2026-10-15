export interface ChunkOptions {
	size?: number;
	overlap?: number;
}

/**
 * Split text into overlapping chunks, preferring heading, paragraph, line, sentence
 * and finally hard boundaries, in that order.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
	const size = options.size ?? 800;
	const overlap = Math.min(options.overlap ?? 120, Math.floor(size / 2));
	const normalized = text.replace(/\r\n/g, "\n").trim();
	if (!normalized) return [];

	const pieces = split(normalized, size, ["\n#", "\n\n", "\n", "。", ". ", " "]);
	const chunks: string[] = [];
	let current = "";
	for (const piece of pieces) {
		if (current && current.length + piece.length > size) {
			chunks.push(current.trim());
			current = current.slice(Math.max(0, current.length - overlap));
		}
		current += piece;
	}
	if (current.trim()) chunks.push(current.trim());
	return chunks;
}

function split(text: string, size: number, separators: string[]): string[] {
	if (text.length <= size) return [text];
	const [sep, ...rest] = separators;
	if (sep === undefined) {
		const out: string[] = [];
		for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
		return out;
	}
	const parts = text.split(sep);
	if (parts.length === 1) return split(text, size, rest);
	return parts.flatMap((part, i) => split(i === 0 ? part : sep + part, size, rest));
}
