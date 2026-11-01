// Binary WebSocket frames: a server frame that carries raw bytes (a video frame from a plugin stream) travels as one
// binary message instead of JSON with base64, so it is neither inflated by a third nor run through permessage-deflate.
//
// Layout: [u32 big-endian header length][header: UTF-8 JSON of the frame without `binary`][payload bytes]

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeBinaryFrame(header: Record<string, unknown>, payload: Uint8Array): Uint8Array {
	const head = encoder.encode(JSON.stringify(header));
	const out = new Uint8Array(4 + head.length + payload.length);
	new DataView(out.buffer).setUint32(0, head.length);
	out.set(head, 4);
	out.set(payload, 4 + head.length);
	return out;
}

/** Undefined when the bytes are not a well-formed binary frame. */
export function decodeBinaryFrame(bytes: Uint8Array): { header: Record<string, unknown>; payload: Uint8Array } | undefined {
	if (bytes.length < 4) return undefined;
	const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
	if (4 + len > bytes.length) return undefined;
	try {
		const header = JSON.parse(decoder.decode(bytes.subarray(4, 4 + len))) as unknown;
		if (!header || typeof header !== "object" || Array.isArray(header)) return undefined;
		return { header: header as Record<string, unknown>, payload: bytes.subarray(4 + len) };
	} catch {
		return undefined;
	}
}
