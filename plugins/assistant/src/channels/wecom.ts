import { createDecipheriv, createHash } from "node:crypto";
import { type AdapterEnv, chunk } from "./types.ts";

interface Cfg {
	corpId: string;
	agentId: string;
	secret: string;
	token: string;
	aesKey: string;
}

const sha1 = (parts: string[]) => createHash("sha1").update([...parts].sort().join("")).digest("hex");

export function wecomDecrypt(encrypted: string, aesKey: string): { msg: string; corpId: string } {
	const key = Buffer.from(`${aesKey}=`, "base64");
	const d = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
	d.setAutoPadding(false);
	let buf = Buffer.concat([d.update(Buffer.from(encrypted, "base64")), d.final()]);
	const pad = buf[buf.length - 1]!;
	if (pad >= 1 && pad <= 32) buf = buf.subarray(0, buf.length - pad);
	const len = buf.readUInt32BE(16);
	return { msg: buf.subarray(20, 20 + len).toString("utf8"), corpId: buf.subarray(20 + len).toString("utf8") };
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`).exec(xml)?.[1] ?? "";

/** WeCom (企业微信) self-built app callback: /plugins/assistant/hook/wecom. */
export function createWecom(cfg: Cfg, env: AdapterEnv) {
	let token = "";
	let exp = 0;
	const access = async () => {
		if (token && Date.now() < exp - 60_000) return token;
		const r = await env.fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.corpId)}&corpsecret=${encodeURIComponent(cfg.secret)}`);
		const d = (await r.json()) as { access_token?: string; expires_in?: number };
		if (!d.access_token) throw new Error("WeCom token request failed");
		token = d.access_token;
		exp = Date.now() + (d.expires_in ?? 7000) * 1000;
		return token;
	};
	const send = async (user: string, text: string) => {
		for (const part of chunk(text, 600)) {
			await env.fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${await access()}`, {
				method: "POST",
				body: JSON.stringify({ touser: user, msgtype: "text", agentid: Number(cfg.agentId), text: { content: part } }),
			});
		}
	};

	return {
		/** URL verification (GET). Returns the plain echo string, or null when the signature is wrong. */
		verify(q: URLSearchParams): string | null {
			const echo = q.get("echostr") ?? "";
			if (sha1([cfg.token, q.get("timestamp") ?? "", q.get("nonce") ?? "", echo]) !== q.get("msg_signature")) return null;
			try {
				const r = wecomDecrypt(echo, cfg.aesKey);
				return r.corpId === cfg.corpId ? r.msg : null;
			} catch {
				return null;
			}
		},
		/** Incoming message (POST). Returns false when the signature or content is not acceptable. */
		receive(q: URLSearchParams, xml: string): boolean {
			const enc = tag(xml, "Encrypt");
			if (!enc || sha1([cfg.token, q.get("timestamp") ?? "", q.get("nonce") ?? "", enc]) !== q.get("msg_signature")) return false;
			try {
				const r = wecomDecrypt(enc, cfg.aesKey);
				if (r.corpId !== cfg.corpId) return false;
				if (tag(r.msg, "MsgType") === "text") {
					const user = tag(r.msg, "FromUserName");
					const text = tag(r.msg, "Content").trim();
					if (user && text) void env.deliver(user, text, (t) => send(user, t));
				}
				return true;
			} catch {
				return false;
			}
		},
	};
}
