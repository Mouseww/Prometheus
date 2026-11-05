import type { Db, DbScope } from "../db/db.ts";
import { toIso } from "../db/db.ts";
import type { HubLog } from "../log.ts";
import type { Actor } from "../permissions.ts";

export interface ServiceDeps {
	db: Db;
	log: HubLog;
	now: () => number;
}

/** Transaction scope that makes RLS see this actor. */
export const scopeOf = (actor: Actor): DbScope => ({ userId: actor.userId, operator: actor.operator });

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const emailDomain = (email: string): string => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** URL-safe slug; falls back to "org" for names with no ASCII letters or digits. */
export function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "org";
}

export interface UserRow {
	id: string;
	email: string;
	display_name: string;
	password_hash: string;
	status: "pending" | "active" | "disabled";
	email_verified_at: Date | string | null;
	platform_role: "operator" | null;
	created_at: Date | string;
}

export interface PublicUser {
	id: string;
	email: string;
	displayName: string;
	status: "pending" | "active" | "disabled";
	platformRole: "operator" | null;
	emailVerifiedAt: string | null;
	createdAt: string;
}

/** Never includes the password hash. */
export function toPublicUser(row: UserRow): PublicUser {
	return {
		id: row.id,
		email: row.email,
		displayName: row.display_name,
		status: row.status,
		platformRole: row.platform_role,
		emailVerifiedAt: toIso(row.email_verified_at),
		createdAt: toIso(row.created_at) as string,
	};
}

export const USER_COLUMNS = "id, email, display_name, password_hash, status, email_verified_at, platform_role, created_at";
