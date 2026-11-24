import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createChannels } from "../src/channels/index.ts";
import { feishuDecrypt } from "../src/channels/feishu.ts";
import { wecomDecrypt } from "../src/channels/wecom.ts";

describe("channel crypto", () => {
	it("decrypts a Feishu event", () => {
		const key = createHash("sha256").update("k").digest();
		const iv = Buffer.alloc(16, 1);
		const c = createCipheriv("aes-256-cbc", key, iv);
		const enc = Buffer.concat([iv, c.update("{\"a\":1}"), c.final()]).toString("base64");
		expect(feishuDecrypt(enc, "k")).toBe("{\"a\":1}");
	});
	it("decrypts a WeCom message", () => {
		const aes = Buffer.alloc(32, 7).toString("base64").slice(0, 43);
		const key = Buffer.from(`${aes}=`, "base64");
		const msg = Buffer.from("hello");
		const len = Buffer.alloc(4);
		len.writeUInt32BE(msg.length);
		let body = Buffer.concat([Buffer.alloc(16, 2), len, msg, Buffer.from("corp")]);
		const pad = 32 - (body.length % 32);
		body = Buffer.concat([body, Buffer.alloc(pad, pad)]);
		const c = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
		c.setAutoPadding(false);
		const enc = Buffer.concat([c.update(body), c.final()]).toString("base64");
		expect(wecomDecrypt(enc, aes)).toEqual({ msg: "hello", corpId: "corp" });
	});
});

describe("channel manager", () => {
	it("hides secrets and keeps them when the mask is sent back", async () => {
		let saved: any = {};
		const ch = createChannels({ load: async () => saved, save: async (c) => void (saved = c), ask: vi.fn(), log: { info() {}, warn() {} } });
		await ch.set("feishu", { enabled: false, appId: "a", appSecret: "s3", verificationToken: "t", allow: "u1, u2" });
		const v: any = await ch.view();
		expect(v.feishu.appSecret).not.toBe("s3");
		await ch.set("feishu", { appSecret: v.feishu.appSecret });
		expect(saved.feishu.appSecret).toBe("s3");
		expect(saved.feishu.allow).toEqual(["u1", "u2"]);
	});
	it("refuses unknown senders without calling the assistant", async () => {
		const ask = vi.fn(async () => ({ ok: true, reply: "hi" }));
		const ch = createChannels({ load: async () => ({ feishu: { enabled: true, appId: "a", appSecret: "s", verificationToken: "t", allow: ["ok"] } }), save: async () => {}, ask, log: { info() {}, warn() {} } });
		await ch.start();
		const body = (peer: string, id: string) => JSON.stringify({ header: { token: "t", event_type: "im.message.receive_v1", event_id: id }, event: { sender: { sender_id: { open_id: peer } }, message: { message_type: "text", message_id: "m", content: JSON.stringify({ text: "yo" }) } } });
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
		expect(ch.feishu(body("stranger", "e1")).status).toBe(200);
		await new Promise((r) => setTimeout(r, 20));
		expect(ask).not.toHaveBeenCalled();
		expect(ch.feishu(JSON.stringify({ header: { token: "bad" } })).status).toBe(401);
		ch.stop();
	});
});
