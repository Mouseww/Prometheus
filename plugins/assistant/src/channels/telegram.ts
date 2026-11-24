import { type Adapter, type AdapterEnv, chunk, sleep } from "./types.ts";

/** Long polling: no public address needed, the server only makes outgoing requests. */
export function startTelegram(cfg: { token: string }, env: AdapterEnv): Adapter {
	const ac = new AbortController();
	const api = (method: string, body: unknown, signal = ac.signal) =>
		env.fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });

	void (async () => {
		let offset = 0;
		let failures = 0;
		while (!ac.signal.aborted) {
			try {
				const res = await api("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
				const data = (await res.json()) as { ok: boolean; description?: string; result?: { update_id: number; message?: { text?: string; chat: { id: number }; from?: { id: number } } }[] };
				if (!data.ok) throw new Error(data.description ?? `HTTP ${res.status}`);
				failures = 0;
				env.setStatus("connected");
				for (const u of data.result ?? []) {
					offset = u.update_id + 1;
					const m = u.message;
					if (!m?.text || !m.from) continue;
					const chatId = m.chat.id;
					void env.deliver(String(m.from.id), m.text, async (text) => {
						for (const part of chunk(text, 4000)) await api("sendMessage", { chat_id: chatId, text: part });
					});
				}
			} catch (e) {
				if (ac.signal.aborted) return;
				failures++;
				env.setStatus(`error: ${(e as Error).message}`);
				await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), ac.signal);
			}
		}
	})();
	return { stop: () => ac.abort() };
}
