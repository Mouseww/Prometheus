export const ZERO_OID = "0".repeat(40);

export interface RefCommand {
	oldOid: string;
	newOid: string;
	ref: string;
}

export type CommandParse =
	| { kind: "incomplete" }
	| { kind: "invalid"; reason: string }
	| { kind: "done"; commands: RefCommand[]; consumed: number };

const MAX_COMMAND_BYTES = 1024 * 1024;
const OID = /^[0-9a-f]{40,64}$/;

/**
 * Parses the command section at the start of a `git-receive-pack` request body (pkt-line framing):
 * optional `shallow <oid>` lines, then `<old> <new> <ref>` lines (the first carries `\0capabilities`), ended by a flush packet `0000`.
 * Returns `incomplete` until the flush packet has arrived. `consumed` is the byte length of the section including the flush.
 */
export function parseReceivePackCommands(buf: Buffer): CommandParse {
	const commands: RefCommand[] = [];
	let pos = 0;
	for (;;) {
		if (pos + 4 > buf.length) return buf.length > MAX_COMMAND_BYTES ? { kind: "invalid", reason: "命令过长" } : { kind: "incomplete" };
		const header = buf.toString("latin1", pos, pos + 4);
		if (!/^[0-9a-fA-F]{4}$/.test(header)) return { kind: "invalid", reason: "pkt-line 长度无效" };
		const len = Number.parseInt(header, 16);
		if (len === 0) return { kind: "done", commands, consumed: pos + 4 };
		if (len < 4) return { kind: "invalid", reason: "pkt-line 长度无效" };
		if (pos + len > buf.length) return buf.length > MAX_COMMAND_BYTES ? { kind: "invalid", reason: "命令过长" } : { kind: "incomplete" };
		let line = buf.toString("utf8", pos + 4, pos + len);
		pos += len;
		const nul = line.indexOf("\0");
		if (nul >= 0) line = line.slice(0, nul);
		line = line.replace(/\n$/, "");
		if (line.startsWith("shallow ")) continue;
		if (line.startsWith("push-cert")) return { kind: "invalid", reason: "不支持签名推送" };
		const parts = line.split(" ");
		const [oldOid, newOid] = parts;
		const ref = parts.slice(2).join(" ");
		if (parts.length < 3 || !OID.test(oldOid ?? "") || !OID.test(newOid ?? "") || ref.length === 0) {
			return { kind: "invalid", reason: "引用更新命令无效" };
		}
		commands.push({ oldOid: oldOid as string, newOid: newOid as string, ref });
	}
}

const SAFE_REF_TAIL = /^[A-Za-z0-9._\-/]+$/;

/** A ref is pushable by `userId` only inside their own session branch or snapshot namespace (spec section 5.1). */
export function isPushableRef(ref: string, userId: string): boolean {
	for (const prefix of [`refs/heads/session/${userId}/`, `refs/prometheus/snapshots/${userId}/`]) {
		if (!ref.startsWith(prefix)) continue;
		const tail = ref.slice(prefix.length);
		if (tail.length === 0 || !SAFE_REF_TAIL.test(tail)) return false;
		if (tail.includes("..") || tail.includes("//") || tail.endsWith("/") || tail.endsWith(".lock") || tail.split("/").some((s) => s.startsWith("."))) return false;
		return true;
	}
	return false;
}

/** The first command that is not allowed for this user, if any. */
export function firstForbiddenCommand(commands: readonly RefCommand[], userId: string): RefCommand | undefined {
	return commands.find((c) => !isPushableRef(c.ref, userId));
}
