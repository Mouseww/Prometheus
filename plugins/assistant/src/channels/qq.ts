import { type Adapter, type AdapterEnv, chunk, sleep } from "./types.ts";

/** QQ official bot (q.qq.com): outgoing WebSocket to the gateway; single chats and @-mentions in groups. */
export function startQQ(cfg: { appId: string; appSecret: string; sandbox?: boolean }, env: AdapterEnv): Adapter {
	const ac = new AbortController();
	const base = cfg.sandbox ? "https://sandbox.api.sgroup.qq.com" : "https://api.sgroup.qq.com";
	let token = "";
	let tokenExp = 0;

	const getToken = async (): Promise<string> => {
		if (token && Date.now() < tokenExp - 60_000) return token;
		const r = await env.fetch("https://bots.qq.com/app/getAppAccessToken", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.appSecret }) });
		const d = (await r.json()) as { access_token?: string; expires_in?: string | number };
		if (!d.access_token) throw new Error("QQ access token request failed");
		token = d.access_token;
		tokenExp = Date.now() + Number(d.expires_in ?? 7000) * 1000;
		return token;
	};
	const call = async (path: string, init?: { body?: unknown }) => {
		const r = await env.fetch(base + path, { method: init ? "POST" : "GET", headers: { authorization: `QQBot ${await getToken()}`, "content-type": "application/json" }, body: init ? JSON.stringify(init.body) : undefined });
		return (await r.json()) as Record<string, unknown>;
	};

	const session = async () => {
		const gw = (await call("/gateway")) as { url?: string };
		if (!gw.url) throw new Error("QQ gateway url missing");
		await new Promise<void>((resolve) => {
			const ws = new WebSocket(gw.url!);
			let seq: number | null = null;
			let beat: ReturnType<typeof setInterval> | undefined;
			const done = () => (clearInterval(beat), resolve());
			ac.signal.addEventListener("abort", () => (ws.close(), done()), { once: true });
			ws.onclose = done;
			ws.onerror = done;
			ws.onmessage = async (ev) => {
				const p = JSON.parse(String(ev.data)) as { op: number; s?: number; t?: string; d?: any };
				if (p.s != null) seq = p.s;
				if (p.op === 10) {
					beat = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ op: 1, d: seq })), p.d.heartbeat_interval);
					// 1 << 25: group and single-chat messages.
					ws.send(JSON.stringify({ op: 2, d: { token: `QQBot ${await getToken()}`, intents: 1 << 25, shard: [0, 1], properties: {} } }));
				} else if (p.op === 7 || p.op === 9) ws.close();
				else if (p.op === 0 && p.t === "READY") env.setStatus("connected");
				else if (p.op === 0 && (p.t === "C2C_MESSAGE_CREATE" || p.t === "GROUP_AT_MESSAGE_CREATE")) {
					const d = p.d;
					const group = p.t === "GROUP_AT_MESSAGE_CREATE";
					const peer = String(group ? d.author.member_openid : d.author.user_openid);
					const path = group ? `/v2/groups/${d.group_openid}/messages` : `/v2/users/${d.author.user_openid}/messages`;
					let n = 0;
					void env.deliver(peer, String(d.content ?? "").trim(), async (text) => {
						for (const part of chunk(text, 1800)) await call(path, { body: { content: part, msg_type: 0, msg_id: d.id, msg_seq: ++n } });
					});
				}
			};
		});
	};

	void (async () => {
		let failures = 0;
		while (!ac.signal.aborted) {
			try {
				await session();
				failures = 0;
			} catch (e) {
				failures++;
				env.setStatus(`error: ${(e as Error).message}`);
			}
			if (!ac.signal.aborted) await sleep(Math.min(60_000, 2000 * 2 ** Math.min(failures, 5)), ac.signal);
		}
	})();
	return { stop: () => ac.abort() };
}
