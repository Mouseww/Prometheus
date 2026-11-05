import { TeamError } from "../types.ts";

const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

function part(value: string, what: string): string {
	if (!SAFE.test(value)) throw new TeamError("invalidParams", `${what} 含有不允许出现在 ref 名中的字符`);
	return value;
}

/** Where the writer side pushes its newest snapshot of a session (spec 5). Only this user may push below `snapshots/<userId>/`. */
export const snapshotRef = (userId: string, hubSessionId: string): string => `refs/prometheus/snapshots/${part(userId, "用户 id")}/${part(hubSessionId, "会话 id")}/latest`;

/** Where a side keeps the state it overwrote because the user had edited the files since the last apply. Local to the repository. */
export const conflictRef = (userId: string, hubSessionId: string, timestamp: number): string =>
	`refs/prometheus/snapshots/${part(userId, "用户 id")}/${part(hubSessionId, "会话 id")}/conflict-${Math.trunc(timestamp)}`;

/** The leaf ref older versions pushed (`.../<sessionId>`). It blocks `.../<sessionId>/latest` (a ref cannot be both a file and a directory). */
export const legacySnapshotRef = (userId: string, hubSessionId: string): string => `refs/prometheus/snapshots/${part(userId, "用户 id")}/${part(hubSessionId, "会话 id")}`;
