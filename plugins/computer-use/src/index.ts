import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createJsonStore, definePlugin } from "@prometheus/plugin-sdk";
import { AuditLog } from "./audit.ts";
import { type ComputerSettings, ComputerService, DEFAULT_SETTINGS } from "./computer.ts";
import { Decider, type DeciderConfig, describeDecider, parseDeciderConfig } from "./decider.ts";
import { AdbDriver } from "./driver/adb.ts";
import { startLocalDriver } from "./driver/local.ts";
import type { Driver } from "./protocol.ts";
import { GUIDELINES, registerTools } from "./tools.ts";

interface Stored {
	settings: Partial<ComputerSettings>;
	decider: DeciderConfig;
}

const MASK = "••••••";
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : undefined);
const num = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

/** Accepts only known keys with sane values; anything else from a client or config is dropped. */
function sanitizeSettings(raw: unknown): Partial<ComputerSettings> {
	const r = (raw ?? {}) as Record<string, unknown>;
	const out: Partial<ComputerSettings> = {
		allowApps: strList(r.allowApps),
		denyApps: strList(r.denyApps),
		snapshotTokens: num(r.snapshotTokens, 300, 12_000),
		settleMs: num(r.settleMs, 50, 2000),
		settleTimeoutMs: num(r.settleTimeoutMs, 200, 15_000),
		confirmIrreversible: bool(r.confirmIrreversible),
		allowIrreversibleUnattended: bool(r.allowIrreversibleUnattended),
		device: r.device === "adb" || r.device === "local" ? r.device : undefined,
		adbPath: typeof r.adbPath === "string" && r.adbPath.trim() ? r.adbPath.trim() : undefined,
		adbSerial: typeof r.adbSerial === "string" ? r.adbSerial.trim() : undefined,
	};
	for (const k of Object.keys(out) as (keyof ComputerSettings)[]) if (out[k] === undefined) delete out[k];
	return out;
}

const maskDecider = (d: DeciderConfig): DeciderConfig => (d.kind === "openai" && d.apiKey ? { ...d, apiKey: MASK } : d);

export default definePlugin({
	name: "computer-use",
	version: "0.1.0",
	optional: true,
	setup(ctx) {
		const store = createJsonStore<Stored>(join(ctx.dataDir, "settings.json"), () => ({ settings: {}, decider: { kind: "off" } }));
		// Tools read settings synchronously, so keep the merged view in memory and refresh it on every write.
		let stored: Stored = { settings: {}, decider: parseDeciderConfig(ctx.settings.decider) };
		const fromConfig = sanitizeSettings(ctx.settings);
		const settings = (): ComputerSettings => ({ ...DEFAULT_SETTINGS, ...fromConfig, ...stored.settings });
		const deciderConfig = (): DeciderConfig => (stored.decider.kind !== "off" ? stored.decider : parseDeciderConfig(ctx.settings.decider));
		const ready = store.read().then((s) => {
			stored = { settings: sanitizeSettings(s.settings), decider: parseDeciderConfig(s.decider) };
		});

		let driver: Promise<Driver> | undefined;
		let driverKey = "";
		const getDriver = async (): Promise<Driver> => {
			const s = settings();
			const key = s.device === "adb" ? `adb:${s.adbPath}:${s.adbSerial}` : "local";
			if (driver) {
				const d = await driver.catch(() => undefined);
				if (d && !d.closed && key === driverKey) return d;
				d?.close(); // device setting changed or the driver died
			}
			driverKey = key;
			driver = s.device === "adb" ? AdbDriver.connect(s.adbPath, s.adbSerial || undefined) : startLocalDriver(ctx.dataDir, (m) => ctx.log.warn(m));
			driver.catch(() => {
				driver = undefined;
			});
			return driver;
		};
		ctx.onDispose(async () => {
			const d = await driver?.catch(() => undefined);
			d?.close();
		});

		const audit = new AuditLog(join(ctx.dataDir, "audit.jsonl"));
		const decider = new Decider(deciderConfig, () => ctx.gateways());
		const selfPids = new Set([process.pid, process.ppid]);
		const svc = new ComputerService({ driver: getDriver, settings, decider, audit, selfPids, device: () => (settings().device === "adb" ? "android" : "local") });

		const save = async (fn: (s: Stored) => Stored) => {
			await ready;
			const next = await store.update((s) => {
				const n = fn({ settings: sanitizeSettings(s.settings), decider: parseDeciderConfig(s.decider) });
				return { settings: sanitizeSettings(n.settings), decider: n.decider };
			});
			stored = { settings: sanitizeSettings(next.settings), decider: parseDeciderConfig(next.decider) };
			ctx.notifyChanged();
		};

		const status = async () => {
			await ready;
			const d = await driver?.catch(() => undefined);
			return {
				paused: svc.paused,
				platform: process.platform,
				driver: d && !d.closed ? d.hello : null,
				decider: maskDecider(deciderConfig()),
				deciderLabel: describeDecider(deciderConfig()),
				settings: settings(),
				audit: join(ctx.dataDir, "audit.jsonl"),
			};
		};

		ctx.rpc("status", status);
		ctx.rpc("pause", () => {
			svc.paused = true;
			ctx.notifyChanged();
			return { paused: true };
		});
		ctx.rpc("resume", () => {
			svc.paused = false;
			ctx.notifyChanged();
			return { paused: false };
		});
		ctx.rpc("settings.set", async (p) => {
			await save((s) => {
				let nextDecider = s.decider;
				if (p.decider !== undefined) {
					const parsed = parseDeciderConfig(p.decider);
					// A masked key coming back from the UI means "keep the stored one".
					if (parsed.kind === "openai" && parsed.apiKey === MASK) parsed.apiKey = s.decider.kind === "openai" ? s.decider.apiKey : undefined;
					nextDecider = parsed;
				}
				return { settings: { ...s.settings, ...sanitizeSettings(p.settings) }, decider: nextDecider };
			});
			return status();
		});

		ctx.extension((pi) => {
			registerTools(pi, svc);

			pi.on("before_agent_start", (event) => {
				event.systemPromptOptions.promptGuidelines.push(...GUIDELINES);
			});

			pi.registerCommand("computer", {
				description: "Computer Use: status | stop | resume | decider off|registry [provider/model]|gateway <id> <model>|openai <baseUrl> <model> [API_KEY_ENV] | decider test",
				handler: async (args: string, cctx: ExtensionCommandContext) => {
					const [cmd = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
					const say = (m: string) => cctx.ui.notify(m, "info");
					switch (cmd) {
						case "stop":
						case "pause":
							svc.paused = true;
							cctx.abort();
							return say("Computer Use 已暂停，当前操作已中止。/computer resume 恢复。");
						case "resume":
							svc.paused = false;
							return say("Computer Use 已恢复。");
						case "decider":
							return deciderCommand(rest, cctx, say);
						default: {
							const s = await status();
							return say(
								[
									`状态：${s.paused ? "已暂停" : "可用"}`,
									`驱动：${s.driver ? `${s.driver.platform} ${s.driver.version}` : "未启动（首次使用时启动）"}`,
									`决策模型：${s.deciderLabel}`,
									`审计日志：${s.audit}`,
								].join("\n"),
							);
						}
					}
				},
			});

			const deciderCommand = async (rest: string[], cctx: ExtensionCommandContext, say: (m: string) => void) => {
				const [kind, a, b, c] = rest;
				let next: DeciderConfig | undefined;
				if (kind === "off") next = { kind: "off" };
				else if (kind === "registry") {
					const [provider, ...model] = (a ?? "").split("/");
					next = { kind: "registry", provider: provider || undefined, model: model.join("/") || undefined };
				} else if (kind === "gateway" && a && b) next = { kind: "gateway", gatewayId: a, model: b };
				else if (kind === "openai" && a && b) next = parseDeciderConfig({ kind: "openai", baseUrl: a, model: b, apiKeyEnv: c });
				else if (kind === "test") {
					const r = await decider.ask(cctx, {
						state: { app: "mail", window: "New message", action: "click", element: { role: "button", name: "Send" } },
						questions: { irreversible: { type: "bool", instructions: "Is this action irreversible?", criteria: { true: "Irreversible", false: "Can be undone" } } },
					});
					const ans = r?.answers.irreversible;
					return say(r && ans?.type === "bool" ? `决策模型 ${r.via} 可用：点击 Send 不可逆的概率 ${ans.probability.toFixed(2)}` : `决策模型不可用（${describeDecider(deciderConfig())}）`);
				} else {
					return say("用法：/computer decider off | registry [provider/model] | gateway <网关id> <模型> | openai <baseUrl> <模型> [API_KEY_ENV] | test");
				}
				if (kind === "openai" && next.kind === "off") return say("baseUrl 必须以 http:// 或 https:// 开头");
				await save((s) => ({ ...s, decider: next! }));
				say(`决策模型：${describeDecider(next)}。用 /computer decider test 验证。`);
			};
		});
	},
});
