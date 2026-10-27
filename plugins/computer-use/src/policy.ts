import type { WindowInfo } from "./protocol.ts";

/**
 * Apps the agent never touches, whatever the permission mode: credential stores, elevation and
 * security prompts, and Prometheus itself (an agent able to click its own permission dialogs has no
 * permission model). Matched against the lower-cased process / bundle / package name.
 */
export const DEFAULT_DENY_APPS = [
	// Prometheus
	"prometheus",
	"prometheus-desktop",
	"dev.prometheus.desktop",
	// Password managers
	"keepass",
	"keepassxc",
	"1password",
	"bitwarden",
	"lastpass",
	"dashlane",
	"enpass",
	"keeper",
	"com.x8bit.bitwarden",
	"com.onepassword.android",
	// OS credentials, elevation and security
	"consent", // UAC
	"credentialuibroker",
	"lockapp",
	"logonui",
	"sechealthui",
	"securityhealthsystray",
	"keychain access",
	"钥匙串访问",
	"com.apple.keychainaccess",
	"com.apple.passwords",
	"passwords",
	"密码",
	"securityagent",
	"com.apple.securityagent",
	"com.apple.systempreferences.security",
	"coreservicesuiagent",
	"com.agilebits.onepassword7",
	"com.1password.1password",
	"com.bitwarden.desktop",
	"polkit-gnome-authentication-agent-1",
	"polkit-kde-authentication-agent-1",
	"gcr-prompter",
	"pinentry",
	"com.android.settings.password",
];

/** Window titles that are always off limits even inside an allowed app (e.g. the Prometheus web UI in a browser). */
// The web UI titles itself "Prometheus" or "<chat> · Prometheus"; browsers append " - Edge", "和另外 N 个页面" and the like.
const DENY_TITLES = [/^Prometheus($|\s[-–—]\s|\s和另外)/, /\s·\sPrometheus($|\s[-–—]\s|\s和另外)/];

export interface PolicySettings {
	/** When non-empty, only these apps may be operated. */
	allowApps: string[];
	/** Added to the built-in deny list. */
	denyApps: string[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\.exe$/, "");

export type AppVerdict = { ok: true } | { ok: false; reason: string };

export function appVerdict(win: Pick<WindowInfo, "app" | "title" | "pid" | "bundleId">, settings: PolicySettings, selfPids: ReadonlySet<number>): AppVerdict {
	// An app is known by its name and, on macOS / Android, by its bundle id or package; either may be listed.
	const names = [norm(win.app), ...(win.bundleId ? [norm(win.bundleId)] : [])];
	if (selfPids.has(win.pid)) return { ok: false, reason: "这是 Prometheus 自身的进程" };
	const deny = [...DEFAULT_DENY_APPS, ...settings.denyApps].map(norm);
	if (names.some((n) => deny.includes(n))) return { ok: false, reason: `应用「${win.app}」在禁止列表中` };
	if (DENY_TITLES.some((re) => re.test(win.title))) return { ok: false, reason: "这是 Prometheus 自身的窗口" };
	const allow = settings.allowApps.map(norm).filter(Boolean);
	if (allow.length && !names.some((n) => allow.includes(n))) return { ok: false, reason: `应用「${win.app}」不在允许列表中（设置 → computer-use → allowApps）` };
	return { ok: true };
}

// ---------- irreversible actions ----------

const IRREVERSIBLE_ZH = /发送|发布|发表|提交|支付|付款|购买|下单|结算|转账|汇款|删除|清空|卸载|格式化|注销账号|永久|确认订单|立即购买|抢购|捐赠|签署|授权登录|同意并/;
const IRREVERSIBLE_EN =
	/\b(send|post|publish|submit|pay|purchase|buy|checkout|place order|transfer|wire|delete|remove|erase|wipe|uninstall|format|empty trash|deactivate|close account|sign and|authorize|donate|confirm payment)\b/i;
/** Labels that contain a keyword but are harmless: navigation and undo, not the act itself. */
const HARMLESS = /撤回|撤销|取消|返回|undo|cancel|back|删除线|strikethrough|草稿|draft|preview|预览/i;

/** Apps where Enter in a text field usually sends the message. */
const MESSAGING_APPS = [
	"wechat", "weixin", "qq", "tim", "wxwork", "wecom", "dingtalk", "feishu", "lark", "telegram", "slack", "teams", "ms-teams",
	"discord", "whatsapp", "signal", "skype", "line", "outlook", "thunderbird", "mail", "com.tencent.mm", "com.tencent.mobileqq",
	"org.telegram.messenger", "com.whatsapp",
];

export interface ActionTarget {
	role: string;
	name?: string;
	states: readonly string[];
}

/** The keyword that makes this action look irreversible by rule, if any. */
export function irreversibleByRule(target: ActionTarget, op: string): string | undefined {
	if (!["click", "double_click", "toggle", "select"].includes(op)) return undefined;
	if (!["button", "link", "menuitem", "listitem", "custom", "text", "image", "checkbox"].includes(target.role)) return undefined;
	const label = target.name ?? "";
	if (!label || HARMLESS.test(label)) return undefined;
	return IRREVERSIBLE_ZH.exec(label)?.[0] ?? IRREVERSIBLE_EN.exec(label)?.[0];
}

/** Enter in a messaging app's text box sends; Ctrl/Cmd+Enter sends in most mail and chat apps. */
export function keysLookIrreversible(keys: string, app: string, focused: ActionTarget | undefined): string | undefined {
	const combos = keys.toLowerCase().split(/\s+/);
	const enter = combos.some((c) => /(^|\+)(enter|return)$/.test(c));
	if (!enter) return undefined;
	if (combos.some((c) => /(ctrl|cmd|meta)\+(enter|return)$/.test(c))) return "Ctrl+Enter";
	if (MESSAGING_APPS.includes(norm(app)) && (!focused || focused.states.includes("editable") || focused.role === "document")) return "Enter（聊天应用）";
	return undefined;
}

/** Writing into a password field is always confirmed: the agent must not type credentials unseen. */
export function isSecretWrite(target: ActionTarget, op: string): boolean {
	return target.states.includes("password") && ["set_value", "type", "clear"].includes(op);
}
