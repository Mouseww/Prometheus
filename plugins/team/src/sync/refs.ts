import { TeamError } from "../types.ts";

const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

/** A git object id as the Hub sends it: SHA-1 (40) or SHA-256 (64) hex, lowercase. Anything else never reaches a git command line. */
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export const isObjectId = (value: unknown): value is string => typeof value === "string" && OBJECT_ID.test(value);

export const isSafeId = (value: unknown): value is string => typeof value === "string" && SAFE.test(value);

function part(value: string, what: string): string {
	if (!SAFE.test(value)) throw new TeamError("invalidParams", `${what} 含有不允许出现在 ref 名中的字符`);
	return value;
}

/** Where the writer side pushes its newest snapshot of a session (spec 5). Only this user may push below `snapshots/<userId>/`. */
export const snapshotRef = (userId: string, hubSessionId: string): string => `refs/prometheus/snapshots/${part(userId, "用户 id")}/${part(hubSessionId, "会话 id")}/latest`;

/** Where a side keeps the state it overwrote because the user had edited the files since the last apply. Local to the repository. */
export const conflictRef = (userId: string, hubSessionId: string, timestamp: number): string =>
	`refs/prometheus/snapshots/${part(userId, "用户 id")}/${part(hubSessionId, "会话 id")}/conflict-${Math.trunc(timestamp)}`;

/** Common start of every conflict ref of one session. */
export const conflictRefPrefix = (userId: string, hubSessionId: string): string => conflictRef(userId, hubSessionId, 0).replace(/0$/, "");

/** Matches exactly the conflict refs of one session; group 1 is the timestamp. */
export const conflictRefPattern = (userId: string, hubSessionId: string): RegExp => new RegExp(`^${conflictRefPrefix(userId, hubSessionId).replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")}(\\d+)$`);

/** The leaf ref older versions pushed (`.../<sessionId>`). It blocks `.../<sessionId>/latest` (a ref cannot be both a file and a directory). */
export const legacySnapshotRef = (userId: string, hubSessionId: string): string => `refs/prometheus/snapshots/${part(userId, "用户 id")}/${part(hubSessionId, "会话 id")}`;
