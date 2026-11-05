import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createHub, type Hub } from "../src/hub.ts";
import type { HubOptions } from "../src/config.ts";
import { silentLog } from "../src/log.ts";
import { tempDir } from "./helpers.ts";

export interface ApiResult<T = any> {
	status: number;
	headers: Headers;
	body: { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
	/** data of a successful reply (throws if the call failed). */
	data: T;
	code: string | undefined;
}

export interface TestHub {
	hub: Hub;
	server: Server;
	baseUrl: string;
	dataDir: string;
	api<T = any>(method: string, path: string, opts?: { body?: unknown; token?: string; ip?: string; headers?: Record<string, string> }): Promise<ApiResult<T>>;
	/** Registers the first (operator) account with the setup code and logs in. */
	bootstrap(email?: string, password?: string): Promise<{ token: string; refreshToken: string; userId: string; orgId: string }>;
	/** Creates an active user through the admin API and logs in as that user. */
	createUser(adminToken: string, email: string, name?: string, orgId?: string): Promise<{ token: string; userId: string; refreshToken: string }>;
	login(email: string, password?: string): Promise<{ token: string; userId: string; refreshToken: string }>;
	stop(): Promise<void>;
}

export const PASSWORD = "correct-horse-battery";
let ipCounter = 1;
const freshIp = (): string => `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

export async function startHub(options: Partial<HubOptions> = {}): Promise<TestHub> {
	const dataDir = await tempDir();
	const hub = await createHub({ dataDir, memory: true, log: silentLog, trustProxy: true, env: {}, ...options });
	const server = createServer((req, res) => {
		void hub.handle(req, res).then((handled) => {
			if (!handled) {
				res.writeHead(404);
				res.end("not handled");
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${options.basePath ?? ""}`;

	const api: TestHub["api"] = async (method, path, opts = {}) => {
		const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? freshIp(), ...opts.headers };
		if (opts.token) headers.authorization = `Bearer ${opts.token}`;
		if (opts.body !== undefined) headers["content-type"] = "application/json";
		const res = await fetch(`${baseUrl}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
		const text = await res.text();
		const body = text ? JSON.parse(text) : undefined;
		return {
			status: res.status,
			headers: res.headers,
			body,
			get data() {
				if (!body?.ok) throw new Error(`请求失败 ${method} ${path}: ${res.status} ${text}`);
				return body.data;
			},
			code: body?.ok === false ? body.error.code : undefined,
		} as ApiResult;
	};

	const login: TestHub["login"] = async (email, password = PASSWORD) => {
		const r = await api("POST", "/api/auth/login", { body: { email, password } });
		return { token: r.data.accessToken, refreshToken: r.data.refreshToken, userId: r.data.user.id };
	};

	return {
		hub,
		server,
		baseUrl,
		dataDir,
		api,
		login,
		async bootstrap(email = "root@corp.test", password = PASSWORD) {
			const code = (await readFile(join(dataDir, "setup-code.txt"), "utf8")).trim();
			const reg = await api("POST", "/api/auth/register", { body: { email, password, displayName: "Root", setupCode: code } });
			if (reg.status !== 201) throw new Error(`引导失败: ${JSON.stringify(reg.body)}`);
			const l = await login(email, password);
			const me = await api("GET", "/api/me", { token: l.token });
			return { ...l, orgId: me.data.orgs[0].id };
		},
		async createUser(adminToken, email, name = email.split("@")[0] as string, orgId) {
			const r = await api("POST", "/api/admin/users", { token: adminToken, body: { email, displayName: name, password: PASSWORD, ...(orgId ? { orgId } : {}) } });
			if (r.status !== 201) throw new Error(`创建用户失败: ${JSON.stringify(r.body)}`);
			return login(email);
		},
		async stop() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await hub.close();
		},
	};
}
