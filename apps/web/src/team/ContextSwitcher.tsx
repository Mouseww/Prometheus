// Header control: Personal or one of the user's organizations. It scopes the Teams list and hosts "create organization".
import clsx from "clsx";
import { Building2, Check, ChevronDown, Plus, UserRound } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button, Dialog, Field, Input } from "../components/ui.tsx";
import { defineMessages, useT } from "../lib/i18n.ts";
import { TeamApiError } from "./api.ts";
import { useTeam } from "./context.tsx";
import { errorText, useCommonT } from "./i18n.ts";
import { Notice } from "./kit.tsx";
import { canCreateOrg, orgIdOfScope, orgScope, SCOPE_ALL, SCOPE_PERSONAL, validScope } from "./logic/publicMode.ts";

const M = defineMessages({
	zh: {
		label: "切换范围",
		all: "全部",
		personal: "个人",
		orgsHeading: "企业",
		create: "创建企业",
		createTitle: "创建企业",
		name: "企业名称",
		slug: "标识（小写字母、数字和连字符，可选）",
		hint: "你会成为这个企业的所有者。",
		unverifiedHelp: "创建企业需要已验证的邮箱。",
		resend: "重新发送验证邮件",
		resent: "验证邮件已发送，请查收。验证后再试一次。",
		busy: "请稍候",
	},
	en: {
		label: "Switch context",
		all: "All",
		personal: "Personal",
		orgsHeading: "Organizations",
		create: "Create organization",
		createTitle: "Create an organization",
		name: "Organization name",
		slug: "Slug (lowercase letters, digits, hyphens; optional)",
		hint: "You become the owner of this organization.",
		unverifiedHelp: "Creating an organization needs a verified email.",
		resend: "Resend verification email",
		resent: "Verification mail sent. Check your inbox, then try again.",
		busy: "Please wait",
	},
});

function CreateOrgDialog({ onClose }: { onClose: () => void }) {
	const { api, me, reloadMe, setScope, resendVerification } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [unverified, setUnverified] = useState(false);
	const [resent, setResent] = useState(false);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError(undefined);
		setUnverified(false);
		try {
			const org = await api.createOrg({ name: name.trim(), ...(slug.trim() ? { slug: slug.trim() } : {}) });
			await reloadMe();
			setScope(orgScope(org.id));
			onClose();
		} catch (err) {
			setError(errorText(err));
			setUnverified(err instanceof TeamApiError && err.code === "emailNotVerified");
		} finally {
			setBusy(false);
		}
	};
	const resend = async () => {
		if (!resendVerification) return;
		setBusy(true);
		try {
			await resendVerification(me.user.email);
			setResent(true);
		} catch (err) {
			setError(errorText(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog title={t("createTitle")} onClose={onClose}>
			<form onSubmit={submit} className="space-y-3">
				<Field label={t("name")} hint={t("hint")}>
					<Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus />
				</Field>
				<Field label={t("slug")}>
					<Input value={slug} onChange={(e) => setSlug(e.target.value)} pattern="[a-z0-9][a-z0-9\-]{0,39}" />
				</Field>
				{error && <Notice kind="error">{error}</Notice>}
				{unverified && (
					<div className="space-y-2 rounded-lg border border-ink-700 p-3">
						<p className="text-xs text-ink-400">{t("unverifiedHelp")}</p>
						{resendVerification && (
							<Button type="button" variant="outline" disabled={busy || resent} onClick={() => void resend()}>
								{t("resend")}
							</Button>
						)}
						{resent && <Notice kind="ok">{t("resent")}</Notice>}
					</div>
				)}
				<div className="flex justify-end gap-2">
					<Button type="button" variant="ghost" onClick={onClose}>
						{c("cancel")}
					</Button>
					<Button type="submit" variant="primary" disabled={busy || !name.trim()}>
						{busy ? t("busy") : c("create")}
					</Button>
				</div>
			</form>
		</Dialog>
	);
}

export function ContextSwitcher() {
	const { me, meta, scope, setScope } = useTeam();
	const t = useT(M);
	const [open, setOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const current = validScope(scope, me);
	const orgId = orgIdOfScope(current);
	const currentLabel = orgId !== undefined ? (me.orgs.find((o) => o.id === orgId)?.name ?? "") : current === SCOPE_PERSONAL ? t("personal") : t("all");
	const creatable = canCreateOrg(me, meta);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	// Nothing to switch between and nothing to create: the header stays quiet.
	if (me.orgs.length === 0 && !creatable) return null;

	const pick = (next: string) => {
		setScope(next);
		setOpen(false);
	};
	const item = (key: string, label: string, value: string, icon: React.ReactNode) => (
		<button
			key={key}
			type="button"
			role="menuitemradio"
			aria-checked={current === value}
			onClick={() => pick(value)}
			className={clsx("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-ink-800", current === value ? "text-ink-100" : "text-ink-300")}
		>
			{icon}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{current === value && <Check className="size-4 text-ember-400" aria-hidden />}
		</button>
	);

	return (
		<div ref={ref} className="relative min-w-0">
			<button
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={`${t("label")}: ${currentLabel}`}
				onClick={() => setOpen((v) => !v)}
				className="flex max-w-56 items-center gap-1.5 rounded-md bg-ink-800 px-2 py-1 text-xs text-ink-200 hover:bg-ink-750 focus-visible:outline-2 focus-visible:outline-ember-400"
			>
				{orgId !== undefined ? <Building2 className="size-3.5 shrink-0" aria-hidden /> : <UserRound className="size-3.5 shrink-0" aria-hidden />}
				<span className="truncate">{currentLabel}</span>
				<ChevronDown className="size-3.5 shrink-0 text-ink-500" aria-hidden />
			</button>
			{open && (
				<div role="menu" aria-label={t("label")} className="absolute left-0 z-30 mt-1 w-60 animate-pop rounded-xl border border-ink-700 bg-ink-900 p-1 shadow-xl shadow-black/50">
					{item("all", t("all"), SCOPE_ALL, <Building2 className="size-4 text-ink-500" aria-hidden />)}
					{item("personal", t("personal"), SCOPE_PERSONAL, <UserRound className="size-4 text-ink-500" aria-hidden />)}
					{me.orgs.length > 0 && <p className="px-3 pt-2 pb-1 text-[10.5px] font-medium tracking-wide text-ink-500 uppercase">{t("orgsHeading")}</p>}
					{me.orgs.map((o) => item(o.id, o.name, orgScope(o.id), <Building2 className="size-4 text-ink-500" aria-hidden />))}
					{creatable && (
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								setOpen(false);
								setCreating(true);
							}}
							className="mt-1 flex w-full items-center gap-2 rounded-lg border-t hairline px-3 py-2 text-left text-sm text-ember-300 hover:bg-ink-800"
						>
							<Plus className="size-4" aria-hidden /> {t("create")}
						</button>
					)}
				</div>
			)}
			{creating && <CreateOrgDialog onClose={() => setCreating(false)} />}
		</div>
	);
}
