import { ACCESS_TOKEN_TTL_SEC, type HubConfig, JWT_AUDIENCE, RATE_LIMIT_PER_ACCOUNT, RATE_LIMIT_PER_IP, REFRESH_TOKEN_TTL_MS } from "../config.ts";
import { dummyPasswordCheck, hashPassword, randomToken, sha256Hex, verifyPassword } from "../crypto.ts";
import type { Queryable } from "../db/db.ts";
import { isUniqueViolation } from "../db/db.ts";
import { badRequest, conflict, forbidden, tooManyRequests, unauthorized } from "../errors.ts";
import { ulid } from "../ids.ts";
import { signJwt } from "../jwt.ts";
import { LOG_PREFIX } from "../log.ts";
import type { Actor, OrgRole } from "../permissions.ts";
import type { RateLimiter } from "../rate-limit.ts";
import type { SetupCode } from "../setup-code.ts";
import type { PublicAccounts, PublicMeta } from "./accounts-public.ts";
import type { AuditService } from "./audit.ts";
import { emailDomain, normalizeEmail, type PublicUser, type ServiceDeps, slugify, toPublicUser, USER_COLUMNS, type UserRow } from "./common.ts";
import type { InvitationsService } from "./invitations.ts";
import { evaluateSelfRegistration, type RegistrationService } from "./registration.ts";
import type { SettingsService } from "./settings.ts";
import type { TeamsService, TeamView } from "./teams.ts";

export interface MetaInfo extends PublicMeta {
	version: string;
	publicKey: string;
	needsSetup: boolean;
	/** Same rule as the billing service: HUB_MODE=public or HUB_BILLING=on (`HubConfig.billingEnabled`). */
	billingEnabled: boolean;
	registration: { open: boolean; domains: string[]; approval: boolean; invite: boolean };
}

export interface RegisterInput {
	email: string;
	password: string;
	displayName: string;
	setupCode?: string;
	inviteToken?: string;
	/** Cloudflare Turnstile response; required in public mode when HUB_TURNSTILE_SECRET is set. */
	turnstileToken?: string;
}

export interface RegisterResult {
	user: PublicUser;
	/** `pending` accounts cannot log in until an administrator approves them (private) or the email is verified (public). */
	status: "active" | "pending";
	/** True for the very first account (operator). */
	bootstrap: boolean;
	/** Public mode: a verification mail was sent and the account stays pending until the link is used. */
	verificationRequired?: boolean;
}

export interface TokenPair {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
	user: PublicUser;
}

export interface MeResult {
	user: PublicUser;
	orgs: { id: string; name: string; role: OrgRole }[];
	teams: { id: string; name: string; role: TeamView["role"]; orgId: string | null }[];
}

export interface ClientInfo {
	ip: string;
	userAgent?: string;
}

export interface AccountsService {
	meta(): Promise<MetaInfo>;
	register(input: RegisterInput, client: ClientInfo): Promise<RegisterResult>;
	login(input: { email: string; password: string }, client: ClientInfo): Promise<TokenPair>;
	refresh(refreshToken: string, client: ClientInfo): Promise<TokenPair>;
	logout(refreshToken: string): Promise<void>;
	me(actor: Actor): Promise<MeResult>;
	/** Creates a user row with a hashed password. Shared with the admin "create user" flow. */
	insertUser(q: Queryable, input: { email: string; displayName: string; passwordHash: string; status: "active" | "pending"; operator?: boolean; verified?: boolean }): Promise<UserRow>;
}

export interface AccountsDeps {
	config: HubConfig;
	privateKey: string;
	publicKey: string;
	audit: AuditService;
	registration: RegistrationService;
	invitations: InvitationsService;
	settings: SettingsService;
	teams: TeamsService;
	setupCode: SetupCode;
	limiter: RateLimiter;
	/** Block 4A: email verification, Turnstile and abuse guards; active only when `config.mode === "public"`. */
	pub: PublicAccounts;
}

/** Serialises first-account and registration races (users table is tiny; contention is irrelevant). */
const REGISTER_LOCK_KEY = 7_421_002;

export function createAccountsService(deps: ServiceDeps, a: AccountsDeps): AccountsService {
	const { config } = a;

	const throttle = (client: ClientInfo, email: string): void => {
		const ip = a.limiter.hit(`auth:ip:${client.ip}`, RATE_LIMIT_PER_IP);
		if (!ip.allowed) throw tooManyRequests(ip.retryAfterSec);
		const acct = a.limiter.hit(`auth:acct:${email}`, RATE_LIMIT_PER_ACCOUNT);
		if (!acct.allowed) throw tooManyRequests(acct.retryAfterSec);
	};

	const insertUser: AccountsService["insertUser"] = async (q, input) => {
		const id = ulid(deps.now());
		try {
			const rows = await q.query<UserRow>(
				`INSERT INTO users (id, email, display_name, password_hash, status, platform_role, email_verified_at)
				 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${USER_COLUMNS}`,
				[id, input.email, input.displayName, input.passwordHash, input.status, input.operator ? "operator" : null, input.verified ? new Date(deps.now()) : null],
			);
			return rows[0] as UserRow;
		} catch (err) {
			if (isUniqueViolation(err)) throw conflict("该邮箱已被注册", "emailTaken");
			throw err;
		}
	};

	const issueTokens = async (q: Queryable, user: UserRow, userAgent: string | undefined): Promise<TokenPair> => {
		const nowMs = deps.now();
		const defaultOrg = await a.settings.defaultOrgId(q);
		const orgs = await q.query<{ org_id: string }>("SELECT org_id FROM org_members WHERE user_id = $1 AND status = 'active' ORDER BY created_at", [user.id]);
		const orgId = orgs.find((o) => o.org_id === defaultOrg)?.org_id ?? orgs[0]?.org_id;
		const iat = Math.floor(nowMs / 1000);
		const accessToken = signJwt(
			{ sub: user.id, name: user.display_name, ...(orgId ? { org: orgId } : {}), iss: config.issuer, aud: JWT_AUDIENCE, iat, exp: iat + ACCESS_TOKEN_TTL_SEC, jti: ulid(nowMs) },
			a.privateKey,
		);
		const refreshToken = randomToken();
		await q.query("INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, user_agent) VALUES ($1,$2,$3,$4,$5)", [
			ulid(nowMs),
			user.id,
			sha256Hex(refreshToken),
			new Date(nowMs + REFRESH_TOKEN_TTL_MS),
			userAgent?.slice(0, 300) ?? null,
		]);
		return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SEC, user: toPublicUser(user) };
	};

	const bootstrapOperator = async (q: Queryable, input: RegisterInput, email: string, passwordHash: string): Promise<RegisterResult> => {
		if (!input.setupCode) throw forbidden("首个账号需要设置码，见 Hub 启动日志或数据目录下的 setup-code.txt", "setupCodeRequired");
		if (!(await a.setupCode.verify(input.setupCode))) throw forbidden("设置码不正确", "invalidSetupCode");
		const user = await insertUser(q, { email, displayName: input.displayName, passwordHash, status: "active", operator: true, verified: true });
		const orgId = ulid(deps.now());
		const slugBase = slugify(config.orgName);
		await q.query("INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)", [orgId, config.orgName, `${slugBase}-${orgId.slice(-6).toLowerCase()}`]);
		await q.query("INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1,$2,'owner','active')", [orgId, user.id]);
		await a.settings.set(q, "default_org_id", orgId);
		await a.audit.write(q, { actorId: user.id, orgId, action: "setup.bootstrap", targetType: "user", targetId: user.id, detail: { orgName: config.orgName } });
		return { user: toPublicUser(user), status: "active", bootstrap: true };
	};

	const registerWithInvite = async (q: Queryable, input: RegisterInput, email: string, passwordHash: string): Promise<RegisterResult> => {
		const inv = await a.invitations.find(q, input.inviteToken as string);
		if (!inv) throw badRequest("邀请无效或已过期", "invalidInvite");
		if (inv.email !== email) throw badRequest("邀请对应的邮箱与注册邮箱不一致", "inviteEmailMismatch");
		const platform = await a.registration.platformPolicy(q);
		if (!platform.allowInvite) throw forbidden("当前不允许通过邀请注册", "inviteDisabled");
		const orgId =
			inv.scope === "org" ? inv.scope_id : ((await q.query<{ org_id: string | null }>("SELECT org_id FROM teams WHERE id = $1", [inv.scope_id]))[0]?.org_id ?? null);
		if (orgId) {
			const orgPolicy = await a.registration.orgPolicy(orgId, q);
			if (orgPolicy && !orgPolicy.allowInvite) throw forbidden("该企业不允许通过邀请注册", "inviteDisabled");
		}
		// Public mode: any team admin can invite an arbitrary address, so the invite proves nothing about ownership of the mailbox.
		// The abuse guards ran before this transaction; the account joins but stays pending (no login, no free credit grant,
		// no invites) until the mailbox is verified, exactly like a self-registered account.
		const isPublic = config.mode === "public";
		const status = isPublic ? "pending" : "active";
		const user = await insertUser(q, { email, displayName: input.displayName, passwordHash, status, verified: !isPublic });
		await a.invitations.apply(q, inv, user.id);
		await a.audit.write(q, { actorId: user.id, orgId, action: "user.register.invite", targetType: "user", targetId: user.id, detail: { invitationId: inv.id } });
		return { user: toPublicUser(user), status, bootstrap: false, ...(isPublic ? { verificationRequired: true } : {}) };
	};

	const registerSelf = async (q: Queryable, input: RegisterInput, email: string, passwordHash: string): Promise<RegisterResult> => {
		const platform = await a.registration.platformPolicy(q);
		// Public mode: nobody is auto-joined to an organization; the account waits for email verification.
		const isPublic = config.mode === "public";
		const defaultOrg = isPublic ? undefined : await a.settings.defaultOrgId(q);
		const orgPolicy = defaultOrg ? await a.registration.orgPolicy(defaultOrg, q) : undefined;
		const decision = evaluateSelfRegistration(platform, orgPolicy, email);
		if (!decision.allowed) {
			throw decision.reason === "closed"
				? forbidden("注册已关闭，请联系管理员或使用邀请链接", "registrationClosed")
				: forbidden(`邮箱域名 ${emailDomain(email)} 不在允许注册的范围内`, "domainNotAllowed");
		}
		const status = decision.requireApproval || isPublic ? "pending" : "active";
		const user = await insertUser(q, { email, displayName: input.displayName, passwordHash, status });
		if (defaultOrg) {
			await q.query("INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1,$2,'member',$3)", [defaultOrg, user.id, status]);
		}
		await a.audit.write(q, { actorId: user.id, orgId: defaultOrg ?? null, action: "user.register", targetType: "user", targetId: user.id, detail: { status } });
		return { user: toPublicUser(user), status, bootstrap: false, ...(isPublic ? { verificationRequired: true } : {}) };
	};

	return {
		insertUser,

		async meta() {
			const [platform, count, extra] = await Promise.all([a.registration.platformPolicy(), deps.db.query<{ n: string | number }>("SELECT count(*) AS n FROM users"), a.pub.meta()]);
			return {
				...extra,
				version: config.version,
				publicKey: a.publicKey,
				needsSetup: Number(count[0]?.n ?? 0) === 0,
				billingEnabled: config.billingEnabled,
				registration: { open: platform.allowOpen && !platform.closed, domains: platform.closed ? [] : platform.allowedDomains, approval: platform.requireApproval, invite: platform.allowInvite },
			};
		},

		async register(input, client) {
			const email = normalizeEmail(input.email);
			throttle(client, email);
			// Invitation registration is guarded too: an invite can name any address, so it must not bypass the abuse controls.
			if (config.mode === "public") await a.pub.guardRegister({ email, turnstileToken: input.turnstileToken }, client.ip);
			const passwordHash = await hashPassword(input.password);
			const result = await deps.db.tx({ system: true }, async (q) => {
				await q.query("SELECT pg_advisory_xact_lock($1)", [REGISTER_LOCK_KEY]);
				const users = await q.query<{ n: string | number }>("SELECT count(*) AS n FROM users");
				if (Number(users[0]?.n ?? 0) === 0) return bootstrapOperator(q, input, email, passwordHash);
				return input.inviteToken ? registerWithInvite(q, input, email, passwordHash) : registerSelf(q, input, email, passwordHash);
			});
			if (result.bootstrap) {
				await a.setupCode.clear();
				deps.log.info(`${LOG_PREFIX} 已创建首个管理员账号 ${result.user.email} 与默认企业`);
			}
			if (result.verificationRequired) await a.pub.sendVerification({ id: result.user.id, email: result.user.email, displayName: result.user.displayName });
			return result;
		},

		async login(input, client) {
			const email = normalizeEmail(input.email);
			throttle(client, email);
			const rows = await deps.db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE email = $1`, [email]);
			const user = rows[0];
			if (!user) {
				await dummyPasswordCheck();
				throw unauthorized("邮箱或密码错误", "invalidCredentials");
			}
			if (!(await verifyPassword(input.password, user.password_hash))) throw unauthorized("邮箱或密码错误", "invalidCredentials");
			// Status is revealed only after the password proved correct.
			if (user.status === "pending" && config.mode === "public" && user.email_verified_at === null) throw forbidden("请先验证邮箱，验证邮件已发送至注册邮箱", "emailNotVerified");
			if (user.status === "pending") throw forbidden("账号正在等待管理员审批", "pendingApproval");
			if (user.status === "disabled") throw forbidden("账号已被禁用", "accountDisabled");
			return deps.db.tx({ system: true }, (q) => issueTokens(q, user, client.userAgent));
		},

		async refresh(refreshToken, client) {
			// A reused (already rotated) token must revoke the family, and that write has to survive the 401, so the outcome is decided
			// inside the transaction and thrown after it commits.
			const outcome = await deps.db.tx({ system: true }, async (q): Promise<TokenPair | "invalid"> => {
				const nowDate = new Date(deps.now());
				const tokenHash = sha256Hex(refreshToken);
				// Revoke-and-read in one statement so a token can be redeemed only once.
				const revoked = await q.query<{ user_id: string }>(
					"UPDATE refresh_tokens SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2 RETURNING user_id",
					[tokenHash, nowDate],
				);
				const userId = revoked[0]?.user_id;
				if (!userId) {
					// Rotation leaves `expires_at` in the future of `revoked_at`; logout pins them together, so those are not replays.
					const replayed = await q.query<{ user_id: string }>(
						"SELECT user_id FROM refresh_tokens WHERE token_hash = $1 AND revoked_at IS NOT NULL AND expires_at > revoked_at AND expires_at > $2",
						[tokenHash, nowDate],
					);
					const victim = replayed[0]?.user_id;
					if (victim) {
						// Whoever presents a rotated token is either the thief or the victim holding a stale copy: end every session of the account.
						await q.query("UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [victim, nowDate]);
						await a.audit.write(q, { actorId: victim, action: "auth.refresh.reuse", targetType: "user", targetId: victim, detail: { ip: client.ip } });
						deps.log.warn(`${LOG_PREFIX} 检测到刷新令牌被重复使用，已撤销用户 ${victim} 的全部会话`);
					}
					return "invalid";
				}
				const users = await q.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
				const user = users[0];
				if (!user || user.status !== "active") throw unauthorized("账号不可用", "accountUnavailable");
				return issueTokens(q, user, client.userAgent);
			});
			if (outcome === "invalid") throw unauthorized("刷新令牌无效或已过期", "invalidRefreshToken");
			return outcome;
		},

		async logout(refreshToken) {
			// Expiry is pinned to the revocation time so a later replay of this token is told apart from a replay of a rotated one.
			await deps.db.query("UPDATE refresh_tokens SET revoked_at = $2, expires_at = LEAST(expires_at, $2) WHERE token_hash = $1 AND revoked_at IS NULL", [sha256Hex(refreshToken), new Date(deps.now())]);
		},

		async me(actor) {
			const rows = await deps.db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [actor.userId]);
			const user = rows[0];
			if (!user) throw unauthorized("账号不存在", "accountUnavailable");
			const orgs = await deps.db.query<{ id: string; name: string; role: OrgRole }>(
				"SELECT o.id, o.name, m.role FROM org_members m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 AND m.status = 'active' ORDER BY o.created_at, o.id",
				[actor.userId],
			);
			const teams = await a.teams.listFor(actor);
			return { user: toPublicUser(user), orgs, teams: teams.map((t) => ({ id: t.id, name: t.name, role: t.role, orgId: t.orgId })) };
		},
	};
}
