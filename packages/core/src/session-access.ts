import type { Identity } from "@prometheus/protocol";

/** Whether a caller may change a session. No owner or no identity (the machine's own user) means yes. */
export function canAct(identity: Identity | undefined, owner: string | undefined): boolean {
	if (owner === undefined || identity === undefined) return true;
	return identity.userId === owner || (identity.actsFor?.includes(owner) ?? false);
}

/**
 * The RPC methods a delegate (an identity that only acts for the server's owner) may call besides the session writes:
 * plain reads that expose no secrets and no machine details. It is an allowlist on purpose, so a method added later is
 * denied to delegates until someone puts it here; a test enumerates every RPC method against it.
 */
export const IDENTITY_READ_ONLY_METHODS: ReadonlySet<string> = new Set([
	"host.info",
	"session.list",
	"session.open",
	"session.messages",
	"session.toolResult",
	"session.stats",
	"usage.stats",
	// Spectators can read the session's files by design: see the design doc, section S3.
	"file.stat",
	"file.read",
	"file.link",
	"workspace.list",
	"settings.get",
	"runtime.list",
	"model.list",
	"commands.list",
	"tools.list",
	"subagent.detail",
	"plugin.list",
	"plugin.compatibility",
	"panel.link",
]);

/**
 * Whether an identity may call `method` on a server whose policy names `serverOwner`. The owner has full access; anyone
 * else (a delegate) only the read-only list and the session writes (which `canAct` then checks per session).
 * Without a serverOwner nothing here applies.
 */
export function identityMayCall(identity: Identity, serverOwner: string | undefined, method: string): boolean {
	if (!serverOwner || identity.userId === serverOwner) return true;
	return IDENTITY_READ_ONLY_METHODS.has(method) || SESSION_WRITE_METHODS.has(method);
}

/** RPC methods that change a session's state; everything else (open, list, stats, reads) is open to spectators. */
export const SESSION_WRITE_METHODS: ReadonlySet<string> = new Set([
	"chat.prompt",
	"chat.abort",
	"chat.compact",
	"chat.unqueue",
	"ui.respond",
	"session.rename",
	"session.close",
	"session.archive",
	"session.delete",
	"session.switchRuntime",
	"message.delete",
	"message.retry",
	"message.edit",
	"goal.set",
	"goal.control",
	"model.set",
	"thinking.set",
	"permission.set",
	"subagent.stop",
]);
