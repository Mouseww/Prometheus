import type { TSchema } from "@earendil-works/pi-ai";

export type Access = "read" | "write";
export type Policy = "read-only" | "confirm" | "allow";

/** How a user proves access to a provider. */
export type AuthMethod =
	| { kind: "token"; label: string; help?: string }
	| { kind: "basic"; help?: string }
	| { kind: "oauth-device"; deviceUrl: string; tokenUrl: string; scopes: string[]; help?: string }
	| { kind: "oauth-code"; authorizeUrl: string; tokenUrl: string; scopes: string[]; help?: string }
	| { kind: "connection-string"; help?: string };

export interface FieldSpec {
	key: string;
	label: string;
	/** Stored encrypted and never returned to clients. */
	secret?: boolean;
	required?: boolean;
	placeholder?: string;
	help?: string;
}

/** What an operation sees when it runs. Secrets are already decrypted and refreshed. */
export interface Credentials {
	config: Record<string, string>;
	/** Bearer/PAT/API token, or OAuth access token. */
	token?: string;
	secrets: Record<string, string>;
}

export interface OperationContext {
	credentials: Credentials;
	signal?: AbortSignal;
	/** Narrowest policy in force; only database-style providers need it to vet free-form input. */
	policy: Policy;
}

export interface Operation {
	name: string;
	description: string;
	access: Access;
	params: TSchema;
	run(params: Record<string, unknown>, ctx: OperationContext): Promise<unknown>;
}

export interface ConnectorProvider {
	id: string;
	name: string;
	category: "code" | "issues" | "mail" | "chat" | "files" | "database";
	description: string;
	/** Auth methods in order of preference; the first is the default. */
	auth: AuthMethod[];
	/** Non-OAuth inputs, per auth method kind. Keys with `secret` go to the encrypted part. */
	fields: Partial<Record<AuthMethod["kind"] | "oauth-app", FieldSpec[]>>;
	operations: Operation[];
	/** Cheap call proving the credentials work; returns a display name for the account. */
	test(ctx: OperationContext): Promise<string>;
}

export interface ConnectionRecord {
	id: string;
	provider: string;
	label: string;
	authKind: AuthMethod["kind"];
	policy: Policy;
	config: Record<string, string>;
	/** Ciphertext of a JSON `StoredSecrets`. */
	secret: string;
	/** Access-token expiry, epoch ms. */
	expiresAt?: number;
	/** Account name reported by `test`. */
	account?: string;
	createdAt: string;
}

export interface StoredSecrets {
	token?: string;
	refreshToken?: string;
	clientId?: string;
	clientSecret?: string;
	values: Record<string, string>;
}

/** What clients may see about a connection: no secrets. */
export interface ConnectionView {
	id: string;
	provider: string;
	label: string;
	authKind: AuthMethod["kind"];
	policy: Policy;
	config: Record<string, string>;
	account?: string;
	expiresAt?: number;
	createdAt: string;
}

export function toView(r: ConnectionRecord): ConnectionView {
	const { secret: _secret, ...rest } = r;
	return rest;
}
