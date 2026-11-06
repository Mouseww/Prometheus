export type ChannelId = "telegram" | "feishu" | "qq" | "wecom";

export interface ChannelsConfig {
	telegram?: { enabled: boolean; token: string; allow: string[] };
	feishu?: { enabled: boolean; appId: string; appSecret: string; verificationToken: string; encryptKey?: string; allow: string[] };
	qq?: { enabled: boolean; appId: string; appSecret: string; sandbox?: boolean; allow: string[] };
	wecom?: { enabled: boolean; corpId: string; agentId: string; secret: string; token: string; aesKey: string; allow: string[] };
}

/** What an adapter hands to the manager for every text message it receives. */
export type Deliver = (peer: string, text: string, reply: (text: string) => Promise<void>) => Promise<void>;

export interface AdapterEnv {
	deliver: Deliver;
	log: { info(m: string): void; warn(m: string): void };
	fetch: typeof fetch;
	setStatus(s: string): void;
}

export interface Adapter {
	stop(): void;
}

/** Split a long reply into pieces the platform accepts. */
export function chunk(text: string, size: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
	return out.length ? out : [""];
}

export const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
	});
