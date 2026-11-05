import type { Identity } from "@prometheus/protocol";

/** Whether a caller may change a session. No owner or no identity (the machine's own user) means yes. */
export function canAct(identity: Identity | undefined, owner: string | undefined): boolean {
	if (owner === undefined || identity === undefined) return true;
	return identity.userId === owner || (identity.actsFor?.includes(owner) ?? false);
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
