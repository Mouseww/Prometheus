import { defineMessages, translate, useT } from "../lib/i18n.ts";
import { usePrefs } from "../lib/prefs.ts";
import { TeamApiError } from "./api.ts";

// Localized texts for the Hub's error codes (packages/hub/src/errors.ts). Unknown codes fall back to the Hub's own message.
const E = defineMessages({
	zh: {
		network: "无法连接到 Hub，请检查网络",
		plugin: "团队插件调用失败",
		noResponse: "团队插件没有响应",
		badResponse: "Hub 返回了无法识别的内容",
		unauthorized: "请先登录",
		invalidToken: "登录已失效，请重新登录",
		forbidden: "没有权限执行此操作",
		notFound: "资源不存在",
		validationError: "输入内容无效",
		rateLimited: "请求过于频繁，请稍后再试",
		accountDisabled: "账号已被停用",
		pendingApproval: "账号正在等待管理员审批",
		emailTaken: "该邮箱已被注册",
		invalidSetupCode: "设置码不正确",
		invalidInvite: "邀请链接无效或已过期",
		inviteDisabled: "当前不接受邀请注册",
		inviteEmailMismatch: "邀请对应的邮箱与注册邮箱不一致",
		alreadyMember: "该用户已经是成员",
		notOrgMember: "该用户不是所属企业的成员",
		notTeamMember: "你不是该团队的成员",
		lastOwner: "不能移除或降级最后一位所有者",
		ownerImmutable: "不能修改所有者",
		cannotActOnSelf: "不能对自己执行此操作",
		personalTeamsDisabled: "此 Hub 不允许创建个人团队",
		orgRequired: "需要选择所属企业",
		invalidRole: "角色无效",
		invalidState: "当前状态下不能执行此操作",
		mergeConflict: "合并请求存在冲突，需要作者解决后刷新",
		mergeDisabled: "此工作区暂时不能合并",
		headMismatch: "分支最新提交与合并请求不一致",
		branchMissing: "会话分支已不存在",
		commitNotFound: "提交不在 Hub 仓库中",
		diffFailed: "无法计算差异",
		importFailed: "导入仓库失败",
		gitUnavailable: "Hub 所在机器没有可用的 git",
		quotaExceeded: "已超出配额",
		notDisabled: "该账号没有被停用",
		notPending: "该账号不在待审批状态",
		skipReviewDenied: "只有团队管理员或审核人可以跳过审核",
		notGranted: "你没有这个会话的操作授权，请联系会话所有者",
		ownerOffline: "会话所有者当前不在线，无法转发操作",
		relayFailed: "所有者的 Prometheus 没有执行这个操作",
		relayTimeout: "所有者的 Prometheus 没有及时响应，请稍后再试",
		billingDisabled: "此 Hub 未启用计费",
		byokDisabled: "当前已禁用自带模型",
		invalidCode: "兑换码无效",
		codeExpired: "兑换码已过期",
		codeExhausted: "兑换码已被用完",
		codeAlreadyRedeemed: "你已经兑换过这个兑换码",
		insufficientCredits: "额度不足，请充值或升级套餐",
		planInUse: "套餐正在被订阅使用，不能删除，可以改为停用",
		priceExists: "该模型和网关已有价目",
		freePlanLocked: "免费套餐不能修改或删除",
		limitReached: "已达到数量上限",
		notManual: "只有线下支付的订单可以手动处理",
		planNotPurchasable: "该套餐无需购买",
		unknownProvider: "不支持的支付方式",
		paymentProviderError: "无法创建支付会话，请稍后再试",
		emailNotVerified: "请先验证邮箱。验证邮件已发送到注册邮箱，可以在下方重新发送。",
		selfCreateOrgDisabled: "运营方已关闭自助创建企业",
		userNotActive: "账号尚未启用",
		transferPending: "该团队已有待处理的转入请求",
		notPersonalTeam: "只有个人团队可以转入企业",
		transferNotPending: "该转入请求已处理",
		orgDisabled: "该企业已停用",
		domainExists: "该域名已在黑名单中",
		turnstileRequired: "请先完成人机验证",
		turnstileFailed: "人机验证未通过，请重试",
		agentBusy: "会话的 Agent 仍在运行。等它结束，或选择中断后再移交。",
		handoffInProgress: "该会话正在移交中",
		alreadyThere: "会话已经在这一端执行",
		notOwner: "只有会话所有者可以切换执行位置",
		runtimeUnavailable: "这个 Hub 没有启用团队 server 运行时",
		targetOffline: "目标一端当前没有连上 Hub，请稍后重试",
		sourceOffline: "源一端当前不在线，无法导出会话",
		handoffTimeout: "移交超时，会话仍在原来的一端",
		handoffFailed: "移交失败，会话仍在原来的一端",
		noSourceSession: "会话在源一端没有对应的本地会话，无法移交",
		capacityExhausted: "执行节点容量已满，正在排队等待",
		adminRequired: "首次启用沙箱需要管理员权限",
	},
	en: {
		network: "Cannot reach the Hub. Check your network.",
		plugin: "The team plugin call failed",
		noResponse: "The team plugin did not respond",
		badResponse: "The Hub returned something unreadable",
		unauthorized: "Please sign in first",
		invalidToken: "Your session expired. Sign in again.",
		forbidden: "You are not allowed to do this",
		notFound: "Not found",
		validationError: "Some input is invalid",
		rateLimited: "Too many requests. Try again shortly.",
		accountDisabled: "This account has been disabled",
		pendingApproval: "This account is waiting for administrator approval",
		emailTaken: "That email is already registered",
		invalidSetupCode: "The setup code is wrong",
		invalidInvite: "The invitation link is invalid or expired",
		inviteDisabled: "Registration by invitation is not enabled",
		inviteEmailMismatch: "The invitation was issued for a different email",
		alreadyMember: "This user is already a member",
		notOrgMember: "This user is not a member of the organization",
		notTeamMember: "You are not a member of this team",
		lastOwner: "The last owner cannot be removed or demoted",
		ownerImmutable: "The owner cannot be changed",
		cannotActOnSelf: "You cannot do this to yourself",
		personalTeamsDisabled: "This Hub does not allow personal teams",
		orgRequired: "Pick an organization",
		invalidRole: "Invalid role",
		invalidState: "This is not possible in the current state",
		mergeConflict: "The merge request has conflicts. The author must resolve them and refresh.",
		mergeDisabled: "This workspace cannot merge right now",
		headMismatch: "The branch tip differs from the merge request",
		branchMissing: "The session branch no longer exists",
		commitNotFound: "The commit is not in the Hub repository",
		diffFailed: "The diff could not be computed",
		importFailed: "Importing the repository failed",
		gitUnavailable: "git is not available on the Hub machine",
		quotaExceeded: "Quota exceeded",
		notDisabled: "This account is not disabled",
		notPending: "This account is not pending approval",
		skipReviewDenied: "Only team admins and reviewers can skip review",
		notGranted: "You are not granted to act on this session. Ask its owner.",
		ownerOffline: "The session owner is offline, so the action cannot be relayed",
		relayFailed: "The owner's Prometheus did not carry out the action",
		relayTimeout: "The owner's Prometheus did not answer in time. Try again shortly.",
		billingDisabled: "Billing is not enabled on this Hub",
		byokDisabled: "Bringing your own models is turned off",
		invalidCode: "This redeem code is not valid",
		codeExpired: "This redeem code has expired",
		codeExhausted: "This redeem code has no uses left",
		codeAlreadyRedeemed: "You have already redeemed this code",
		insufficientCredits: "Not enough credits. Top up or upgrade your plan.",
		planInUse: "The plan is used by subscriptions and cannot be deleted. Deactivate it instead.",
		priceExists: "A price for this model and gateway already exists",
		freePlanLocked: "The free plan cannot be changed or deleted",
		limitReached: "A limit has been reached",
		notManual: "Only offline (manual) orders can be handled by hand",
		planNotPurchasable: "This plan does not need to be purchased",
		unknownProvider: "Unsupported payment method",
		paymentProviderError: "The payment session could not be created. Try again shortly.",
		emailNotVerified: "Verify your email first. A verification mail was sent to the address you registered with; you can send it again below.",
		selfCreateOrgDisabled: "The operator has turned off self-service organizations",
		userNotActive: "This account is not active yet",
		transferPending: "This team already has a pending transfer request",
		notPersonalTeam: "Only personal teams can be moved into an organization",
		transferNotPending: "This transfer request was already handled",
		orgDisabled: "This organization is disabled",
		domainExists: "That domain is already on the list",
		turnstileRequired: "Complete the human check first",
		turnstileFailed: "The human check failed. Try again.",
		agentBusy: "The session's agent is still running. Wait for it, or choose to interrupt it and hand off.",
		handoffInProgress: "This session is being handed off right now",
		alreadyThere: "The session already runs on that side",
		notOwner: "Only the session owner can change where it runs",
		runtimeUnavailable: "This Hub has no team server runtime enabled",
		targetOffline: "The target side is not connected to the Hub. Try again shortly.",
		sourceOffline: "The source side is offline, so the session cannot be exported",
		handoffTimeout: "The handoff timed out. The session stays where it was.",
		handoffFailed: "The handoff failed. The session stays where it was.",
		noSourceSession: "The source side has no local copy of this session, so it cannot be handed off",
		capacityExhausted: "Executor capacity is full. Waiting in the queue.",
		adminRequired: "Enabling the sandbox for the first time needs administrator rights",
	},
});

type ErrorKey = keyof typeof E.zh;

const hasKey = (code: string): code is ErrorKey => code in E.zh;

/** Human readable text for anything thrown by a TeamApi call. */
export function errorText(err: unknown): string {
	const lang = usePrefs.getState().lang;
	if (err instanceof TeamApiError) {
		if (hasKey(err.code)) {
			const base = translate(E, lang, err.code);
			// Validation messages carry the field detail the Hub produced; keep it after the generic line.
			return err.code === "validationError" && err.message ? `${base}: ${err.message}` : base;
		}
		return err.message || translate(E, lang, "network");
	}
	return err instanceof Error ? err.message : String(err);
}

/** Shared labels used across several team pages. */
const C = defineMessages({
	zh: {
		loading: "加载中",
		retry: "重试",
		cancel: "取消",
		save: "保存",
		create: "创建",
		delete: "删除",
		remove: "移除",
		confirm: "确认",
		empty: "暂无内容",
		refresh: "刷新",
		close: "关闭",
		back: "返回",
		copy: "复制",
		copied: "已复制",
		saved: "已保存",
		roleOwner: "所有者",
		roleAdmin: "管理员",
		roleReviewer: "审核人",
		roleMember: "成员",
		statusPending: "待审批",
		statusActive: "正常",
		statusDisabled: "已停用",
		operator: "运营者",
		comingSoon: "即将推出",
		comingSoonBody: "这个页面会在后续版本提供。",
		notifications: "通知",
	},
	en: {
		loading: "Loading",
		retry: "Retry",
		cancel: "Cancel",
		save: "Save",
		create: "Create",
		delete: "Delete",
		remove: "Remove",
		confirm: "Confirm",
		empty: "Nothing here yet",
		refresh: "Refresh",
		close: "Close",
		back: "Back",
		copy: "Copy",
		copied: "Copied",
		saved: "Saved",
		roleOwner: "Owner",
		roleAdmin: "Admin",
		roleReviewer: "Reviewer",
		roleMember: "Member",
		statusPending: "Pending",
		statusActive: "Active",
		statusDisabled: "Disabled",
		operator: "Operator",
		comingSoon: "Coming soon",
		comingSoonBody: "This page arrives in a later release.",
		notifications: "Notifications",
	},
});

export const useCommonT = () => useT(C);

export type CommonT = ReturnType<typeof useCommonT>;

/** Label of any role string used by the Hub (org or team roles). */
export function roleLabel(t: CommonT, role: string): string {
	switch (role) {
		case "owner":
			return t("roleOwner");
		case "admin":
			return t("roleAdmin");
		case "reviewer":
			return t("roleReviewer");
		case "member":
			return t("roleMember");
		default:
			return role;
	}
}

export function statusLabel(t: CommonT, status: string): string {
	return status === "pending" ? t("statusPending") : status === "active" ? t("statusActive") : status === "disabled" ? t("statusDisabled") : status;
}
