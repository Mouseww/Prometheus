import { createDecipheriv, createHash } from "node:crypto";
import { type AdapterEnv, chunk } from "./types.ts";

interface Cfg {
	appId: string;
	appSecret: string;
	verificationToken: string;
	encryptKey?: string;
}

export function feishuDecrypt(encrypt: string, key: string): string {
	const buf = Buffer.from(encrypt, "base64");
	const d = createDecipheriv("aes-256-cbc", createHash("sha256").update(key).digest(), buf.subarray(0, 16));
	return Buffer.concat([d.update(buf.subarray(16)), d.final()]).toString("utf8");
}

/** Event subscription webhook (Feishu open platform → Events → request URL = /plugins/assistant/hook/feishu). */
export function createFeishu(cfg: Cfg, env: AdapterEnv) {
	let token = "";
	let exp = 0;
	const seen = new Set<string>();
	const tenant = async () => {
		if (token && Date.now() < exp - 60_000) return token;
		const r = await env.fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
		});
		const d = (await r.json()) as { tenant_access_token?: string; expire?: number };
		if (!d.tenant_access_token) throw new Error("Feishu tenant token request failed");
		token = d.tenant_access_token;
		exp = Date.now() + (d.expire ?? 7000) * 1000;
		return token;
	};
	const replyTo = async (messageId: string, text: string) => {
		for (const part of chunk(text, 4000)) {
			await env.fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
				method: "POST",
				headers: { authorization: `Bearer ${await tenant()}`, "content-type": "application/json" },
				body: JSON.stringify({ msg_type: "text", content: JSON.stringify({ text: part }) }),
			});
		}
	};

	/** Returns the JSON to answer the platform with. */
	return (raw: string): { status: number; body: unknown } => {
		let body: any;
		try {
			body = JSON.parse(raw);
			if (body.encrypt) {
				if (!cfg.encryptKey) return { status: 400, body: { error: "encrypted event but no encryptKey configured" } };
				body = JSON.parse(feishuDecrypt(body.encrypt, cfg.encryptKey));
			}
		} catch {
			return { status: 400, body: { error: "bad body" } };
		}
		const tok = body.header?.token ?? body.token;
		if (tok !== cfg.verificationToken) return { status: 401, body: { error: "bad token" } };
		if (body.type === "url_verification") return { status: 200, body: { challenge: body.challenge } };
		const id = body.header?.event_id;
		if (body.header?.event_type === "im.message.receive_v1" && id && !seen.has(id)) {
			seen.add(id);
			if (seen.size > 500) seen.delete(seen.values().next().value as string);
			const m = body.event?.message;
			const peer = body.event?.sender?.sender_id?.open_id;
			if (m?.message_type === "text" && peer) {
				let text = "";
				try {
					text = String(JSON.parse(m.content).text ?? "");
				} catch {}
				text = text.replace(/@_user_\d+/g, "").trim();
				if (text) void env.deliver(String(peer), text, (t) => replyTo(m.message_id, t));
			}
		}
		return { status: 200, body: {} };
	};
}
