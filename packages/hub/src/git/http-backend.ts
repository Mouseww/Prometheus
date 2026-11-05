import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough, pipeline, Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { forbidden, HubError, notFound, validationError } from "../errors.ts";
import { LOG_PREFIX, type HubLog } from "../log.ts";
import { baseGitEnv } from "./exec.ts";
import { firstForbiddenCommand, parseReceivePackCommands, type RefCommand } from "./pktline.ts";

const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);
const PASS_HEADERS = new Set(["content-type", "cache-control", "expires", "pragma", "etag", "last-modified"]);
const MAX_COMMAND_SECTION_BYTES = 1024 * 1024;

export interface GitRequestInfo {
	req: IncomingMessage;
	res: ServerResponse;
	reposRoot: string;
	workspaceId: string;
	/** The authenticated user; becomes REMOTE_USER and decides which refs may be pushed. */
	userId: string;
	/** Path below `<id>.git/`, e.g. `info/refs` or `git-receive-pack`. */
	rest: string;
	log: HubLog;
	/** Called with the parsed commands of a push before the backend runs; throws to refuse (403). */
	onPush?: (commands: readonly RefCommand[]) => void;
}

/** Requests the Hub serves: the smart protocol only (no dumb HTTP). Throws 404 for anything else. */
export function classify(method: string, rest: string, query: URLSearchParams): "info" | "upload-pack" | "receive-pack" {
	if (method === "GET" && rest === "info/refs") {
		const service = query.get("service");
		if (service && SERVICES.has(service)) return "info";
		throw notFound("仅支持 git smart HTTP 协议");
	}
	if (method === "POST" && rest === "git-upload-pack") return "upload-pack";
	if (method === "POST" && rest === "git-receive-pack") return "receive-pack";
	throw notFound("接口不存在");
}

/** Request body as a stream, inflated when the client sent `Content-Encoding: gzip`. */
function bodyStream(req: IncomingMessage): Readable {
	const enc = String(req.headers["content-encoding"] ?? "").toLowerCase();
	if (enc === "" || enc === "identity") return req;
	if (enc === "gzip" || enc === "x-gzip") {
		const gunzip = createGunzip();
		req.on("error", (err) => gunzip.destroy(err));
		return req.pipe(gunzip);
	}
	throw new HubError(415, "unsupportedEncoding", "不支持的 Content-Encoding");
}

/** Reads the receive-pack command section off the front of the body. Returns the commands and every byte read so far. */
async function readCommands(body: Readable): Promise<{ commands: RefCommand[]; buffered: Buffer; iterator: AsyncIterator<Buffer> }> {
	const iterator = body[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
	let buffered = Buffer.alloc(0);
	for (;;) {
		const parsed = parseReceivePackCommands(buffered);
		if (parsed.kind === "invalid") throw validationError(`推送请求无效: ${parsed.reason}`);
		if (parsed.kind === "done") return { commands: parsed.commands, buffered, iterator };
		if (buffered.length > MAX_COMMAND_SECTION_BYTES) throw validationError("推送请求无效: 命令过长");
		const next = await iterator.next();
		if (next.done) throw validationError("推送请求无效: 请求体提前结束");
		buffered = Buffer.concat([buffered, next.value]);
	}
}

function sanitizeProtocol(value: string | string[] | undefined): string | undefined {
	const v = Array.isArray(value) ? value[0] : value;
	return v && /^[\w=:.,-]{1,100}$/.test(v) ? v : undefined;
}

interface CgiHead {
	status: number;
	headers: Record<string, string>;
	rest: Buffer;
}

function parseCgiHead(buf: Buffer): CgiHead | undefined {
	const crlf = buf.indexOf("\r\n\r\n");
	const lf = buf.indexOf("\n\n");
	let end = -1;
	let sep = 0;
	if (crlf >= 0 && (lf < 0 || crlf < lf)) {
		end = crlf;
		sep = 4;
	} else if (lf >= 0) {
		end = lf;
		sep = 2;
	}
	if (end < 0) return undefined;
	const headers: Record<string, string> = {};
	let status = 200;
	for (const line of buf.toString("latin1", 0, end).split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const name = line.slice(0, idx).trim().toLowerCase();
		const value = line.slice(idx + 1).trim();
		if (name === "status") status = Number.parseInt(value, 10) || 200;
		else if (PASS_HEADERS.has(name)) headers[name] = value;
	}
	return { status, headers, rest: buf.subarray(end + sep) };
}

/** Bridges one smart HTTP request to `git http-backend` (CGI): streams the body in and the response out. */
export async function serveGitRequest(info: GitRequestInfo): Promise<void> {
	const { req, res } = info;
	const url = new URL(req.url ?? "/", "http://hub.local");
	const kind = classify((req.method ?? "GET").toUpperCase(), info.rest, url.searchParams);

	let input: Readable | undefined;
	if (kind !== "info") {
		const body = bodyStream(req);
		if (kind === "receive-pack") {
			let parsed: Awaited<ReturnType<typeof readCommands>>;
			try {
				parsed = await readCommands(body);
				info.onPush?.(parsed.commands);
			} catch (err) {
				res.setHeader("connection", "close");
				throw err;
			}
			const { buffered, iterator } = parsed;
			input = Readable.from(
				(async function* () {
					yield buffered;
					for (;;) {
						const next = await iterator.next();
						if (next.done) return;
						yield next.value;
					}
				})(),
			);
		} else {
			input = body;
		}
	}

	const env: Record<string, string | undefined> = {
		...baseGitEnv(),
		GIT_PROJECT_ROOT: info.reposRoot,
		GIT_HTTP_EXPORT_ALL: "1",
		GIT_HTTP_MAX_REQUEST_BUFFER: "1g",
		PATH_INFO: `/${info.workspaceId}.git/${info.rest}`,
		REMOTE_USER: info.userId,
		REMOTE_ADDR: req.socket.remoteAddress ?? "",
		QUERY_STRING: url.search.replace(/^\?/, ""),
		REQUEST_METHOD: (req.method ?? "GET").toUpperCase(),
		CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
		HTTP_GIT_PROTOCOL: sanitizeProtocol(req.headers["git-protocol"]),
		HTTP_CONTENT_ENCODING: undefined,
		CONTENT_LENGTH: undefined,
	};
	for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];

	const child = spawn("git", ["http-backend"], { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const stderr: Buffer[] = [];
	child.stderr.on("data", (c: Buffer) => {
		if (stderr.length < 64) stderr.push(c);
	});
	child.stdin.on("error", () => {});
	let finished = false;
	res.on("close", () => {
		if (!finished) child.kill();
	});

	if (input) {
		pipeline(input, child.stdin, () => {});
	} else {
		child.stdin.end();
	}

	const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)));
	const spawnFailed = new Promise<never>((_, reject) => child.on("error", (e) => reject(new HubError(503, "gitUnavailable", `无法运行 git: ${e.message}`))));

	const iterator = child.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
	let head: CgiHead | undefined;
	let acc = Buffer.alloc(0);
	while (!head) {
		const next = await Promise.race([iterator.next(), spawnFailed]);
		if (next.done) break;
		acc = Buffer.concat([acc, next.value]);
		head = parseCgiHead(acc);
	}
	if (!head) {
		const code = await exited;
		finished = true;
		info.log.warn(`${LOG_PREFIX} git http-backend 异常退出 (${code}): ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 300)}`);
		throw new HubError(502, "gitBackendFailed", "git 服务处理请求失败");
	}

	res.writeHead(head.status, { ...head.headers, "cache-control": head.headers["cache-control"] ?? "no-cache" });
	const out = new PassThrough();
	const rest = head.rest;
	const pump = (async () => {
		if (rest.length > 0) out.write(rest);
		for (;;) {
			const next = await iterator.next();
			if (next.done) break;
			if (!out.write(next.value)) await new Promise<void>((resolve) => out.once("drain", resolve));
		}
		out.end();
	})().catch((err: unknown) => out.destroy(err instanceof Error ? err : new Error(String(err))));
	await new Promise<void>((resolve) => pipeline(out, res, () => resolve()));
	await pump;
	finished = true;
	const code = await exited;
	if (code !== 0) info.log.warn(`${LOG_PREFIX} git http-backend 退出码 ${code}: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 300)}`);
}

/** Refuses pushes outside the user's own session and snapshot namespaces (including the default branch). */
export function enforcePushRules(userId: string, commands: readonly RefCommand[]): void {
	const bad = firstForbiddenCommand(commands, userId);
	if (bad) throw forbidden(`不允许推送到 ${bad.ref}：只能推送到 session/${userId}/* 或 refs/prometheus/snapshots/${userId}/*，默认分支只能通过合并请求更新`, "pushForbidden");
}
