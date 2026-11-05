import type { HubOptions } from "../src/config.ts";
import type { HubLog } from "../src/log.ts";
import type { PublicAccounts } from "../src/services/accounts-public.ts";
import { PASSWORD, startHub, type TestHub } from "./hub-helpers.ts";

export interface MailCapture {
	/** Raw log lines the LogMailer wrote (one per mail). */
	mails: string[];
	/** Offset added to the Hub clock (ms); lets tests jump past token expiry. */
	clock: { offsetMs: number };
	/** Latest token of a link (`/verify-email` or `/reset-password`) mailed to `email`. */
	tokenFor(email: string, kind: "verify-email" | "reset-password"): string | undefined;
}

export interface PublicTestHub extends TestHub {
	capture: MailCapture;
	/** Operator session created by `startPublicHub`. */
	operator: { token: string; userId: string; orgId: string };
	/** Waits for fire-and-forget mail delivery. */
	flush(): Promise<void>;
	/** Registers, verifies the mailed link and logs in. */
	registerVerified(email: string, name?: string): Promise<{ token: string; userId: string; refreshToken: string }>;
}

/** Starts a Hub in public mode with open registration and mails captured from the LogMailer output. */
export async function startPublicHub(options: Partial<HubOptions> = {}): Promise<PublicTestHub> {
	const mails: string[] = [];
	const clock = { offsetMs: 0 };
	const log: HubLog = {
		info: (m) => {
			if (m.includes("邮件仅写入日志")) mails.push(m);
		},
		warn: () => {},
		error: () => {},
	};
	const t = await startHub({ mode: "public", log, now: () => Date.now() + clock.offsetMs, ...options });
	const capture: MailCapture = {
		mails,
		clock,
		tokenFor(email, kind) {
			const mine = mails.filter((m) => m.includes(`收件人: ${email}，`) && m.includes(`/${kind}?token=`));
			const last = mine[mine.length - 1];
			return last ? /token=([A-Za-z0-9_-]+)/.exec(last)?.[1] : undefined;
		},
	};
	const operator = await t.bootstrap();
	const policy = { allowOpen: true, allowedDomains: [], requireApproval: false, allowInvite: true, closed: false };
	const put = await t.api("PUT", "/api/admin/registration", { token: operator.token, body: policy });
	if (put.status !== 200) throw new Error(`开放注册失败: ${JSON.stringify(put.body)}`);
	const flush = (): Promise<void> => (t.hub.registry.require<PublicAccounts>("publicAccounts") as PublicAccounts).flush();
	return {
		...t,
		capture,
		operator,
		flush,
		async registerVerified(email, name = email.split("@")[0] as string) {
			const reg = await t.api("POST", "/api/auth/register", { body: { email, password: PASSWORD, displayName: name } });
			if (reg.status !== 201) throw new Error(`注册失败: ${JSON.stringify(reg.body)}`);
			await flush();
			const token = capture.tokenFor(email, "verify-email");
			if (!token) throw new Error("没有找到验证邮件");
			const v = await t.api("POST", "/api/auth/verify-email", { body: { token } });
			if (v.status !== 200) throw new Error(`验证失败: ${JSON.stringify(v.body)}`);
			return t.login(email);
		},
	};
}
