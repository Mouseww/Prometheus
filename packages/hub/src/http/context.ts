import type { IncomingMessage, ServerResponse } from "node:http";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { badRequest, unauthorized, validationError } from "../errors.ts";
import type { JwtClaims } from "../jwt.ts";
import type { Actor } from "../permissions.ts";
import type { ClientInfo } from "../services/accounts.ts";

export const MAX_BODY_BYTES = 1024 * 1024;

export interface RouteContext {
	req: IncomingMessage;
	res: ServerResponse;
	method: string;
	/** Path relative to the Hub base, without the query string. */
	path: string;
	params: Readonly<Record<string, string>>;
	searchParams: URLSearchParams;
	client: ClientInfo;
	/** Decoded access token (set for `user` routes, and for `public` routes that sent a valid one). */
	identity: JwtClaims | undefined;
	/** Authenticated user id; throws 401 when the route had no token. */
	userId(): string;
	/** Loads the actor's roles (cached per request). Throws 401 when the account is unavailable. */
	actor(): Promise<Actor>;
	/** Reads and validates the JSON body against a TypeBox schema. */
	json<S extends TSchema>(schema: S): Promise<Static<S>>;
	/** Validates query-string parameters (values arrive as strings and are converted to the schema's types). */
	query<S extends TSchema>(schema: S): Static<S>;
}

function describeFirstError(schema: TSchema, value: unknown): string {
	const first = Value.Errors(schema, value)[0];
	if (!first) return "请求参数无效";
	const where = first.instancePath ? first.instancePath.replace(/^\//, "").replaceAll("/", ".") : "请求体";
	return `参数 ${where} 无效: ${first.message}`;
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > MAX_BODY_BYTES) throw badRequest("请求体过大", "payloadTooLarge");
		chunks.push(buf);
	}
	if (size === 0) return undefined;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw badRequest("请求体不是有效的 JSON", "invalidJson");
	}
}

export interface ContextInit {
	req: IncomingMessage;
	res: ServerResponse;
	method: string;
	path: string;
	params: Record<string, string>;
	searchParams: URLSearchParams;
	client: ClientInfo;
	identity: JwtClaims | undefined;
	loadActor(userId: string): Promise<Actor>;
}

export function createContext(init: ContextInit): RouteContext {
	let actorPromise: Promise<Actor> | undefined;
	return {
		req: init.req,
		res: init.res,
		method: init.method,
		path: init.path,
		params: init.params,
		searchParams: init.searchParams,
		client: init.client,
		identity: init.identity,
		userId() {
			if (!init.identity) throw unauthorized("需要登录", "unauthorized");
			return init.identity.sub;
		},
		actor() {
			if (!init.identity) return Promise.reject(unauthorized("需要登录", "unauthorized"));
			actorPromise ??= init.loadActor(init.identity.sub);
			return actorPromise;
		},
		async json<S extends TSchema>(schema: S): Promise<Static<S>> {
			const body = await readJsonBody(init.req);
			if (!Value.Check(schema, body)) throw validationError(describeFirstError(schema, body));
			return body as Static<S>;
		},
		query<S extends TSchema>(schema: S): Static<S> {
			const raw: Record<string, string> = {};
			for (const [k, v] of init.searchParams) if (!(k in raw)) raw[k] = v;
			const converted = Value.Convert(schema, raw);
			if (!Value.Check(schema, converted)) throw validationError(describeFirstError(schema, converted));
			return converted as Static<S>;
		},
	};
}
