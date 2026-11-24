import { Type } from "typebox";
import type { HubDeps } from "../deps.ts";
import { forbidden } from "../errors.ts";
import { Reply, type Router } from "../http/router.ts";
import { can } from "../permissions.ts";
import { invitesPerDay } from "../services/invitations.ts";
import { lockOutUser } from "../services/lockout.ts";
import type { MailSettingsService } from "../services/mail-settings.ts";
import type { OnboardingService } from "../services/onboarding.ts";
import type { OrgsPublicService } from "../services/orgs-public.ts";
import { MAX_INVITATION_TTL_DAYS, MIN_INVITATION_TTL_DAYS } from "../services/settings.ts";
import { DisplayNameSchema, EmailSchema, IdSchema, NameSchema, OrgRoleSchema, PasswordSchema, RegistrationPolicySchema } from "./schemas.ts";

const UserListQuery = Type.Object({
	status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("active"), Type.Literal("disabled")])),
	q: Type.Optional(Type.String({ maxLength: 100 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
});
const CreateUserBody = Type.Object({ email: EmailSchema, displayName: DisplayNameSchema, password: PasswordSchema, orgId: Type.Optional(IdSchema) });
const InvitationBody = Type.Object({
	scope: Type.Union([Type.Literal("org"), Type.Literal("team")]),
	scopeId: IdSchema,
	email: EmailSchema,
	role: Type.String({ minLength: 1, maxLength: 20 }),
	sendEmail: Type.Optional(Type.Boolean()),
});
const CreateOrgBody = Type.Object({ name: NameSchema, slug: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,39}$" })), ownerUserId: Type.Optional(IdSchema) });
const MemberRoleBody = Type.Object({ role: OrgRoleSchema });
const AuditQuery = Type.Object({
	orgId: Type.Optional(IdSchema),
	actor: Type.Optional(IdSchema),
	action: Type.Optional(Type.String({ maxLength: 100 })),
	before: Type.Optional(IdSchema),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
const SettingsBody = Type.Object({
	allowPersonalTeams: Type.Optional(Type.Boolean()),
	allowSelfCreateOrg: Type.Optional(Type.Boolean()),
	siteName: Type.Optional(Type.String({ maxLength: 60 })),
	invitationTtlDays: Type.Optional(Type.Integer({ minimum: MIN_INVITATION_TTL_DAYS, maximum: MAX_INVITATION_TTL_DAYS })),
});
const MailBody = Type.Object({
	host: Type.String({ minLength: 1, maxLength: 253 }),
	port: Type.Integer({ minimum: 1, maximum: 65535 }),
	security: Type.Union([Type.Literal("tls"), Type.Literal("starttls"), Type.Literal("none")]),
	username: Type.Optional(Type.String({ maxLength: 254 })),
	password: Type.Optional(Type.String({ maxLength: 512 })),
	clearPassword: Type.Optional(Type.Boolean()),
	from: Type.String({ minLength: 3, maxLength: 254 }),
});
const MailTestBody = Type.Object({ to: EmailSchema, config: Type.Optional(MailBody) });
const OnboardingBody = Type.Object({ dismissed: Type.Boolean() });

/** Admin console: users, registration policy, invitations, organizations and members, audit log, platform settings. */
export function registerAdminRoutes(router: Router, deps: HubDeps): void {
	const { adminUsers, registration, invitations, orgs, audit, settings } = deps.services;

	router.get("/api/admin/users", async (ctx) => adminUsers.list(await ctx.actor(), ctx.query(UserListQuery)));
	router.post("/api/admin/users", async (ctx) => new Reply(201, await adminUsers.create(await ctx.actor(), await ctx.json(CreateUserBody))));
	router.post("/api/admin/users/:id/approve", async (ctx) => adminUsers.approve(await ctx.actor(), ctx.params.id as string));
	router.post("/api/admin/users/:id/disable", async (ctx) => {
		const userId = ctx.params.id as string;
		const user = await adminUsers.disable(await ctx.actor(), userId);
		// Same lockout as the operator ban: credentials revoked, sockets closed, tenant instance stopped. Best effort, the account is already disabled.
		await lockOutUser(deps, userId, "disabled");
		return user;
	});
	router.post("/api/admin/users/:id/enable", async (ctx) => adminUsers.enable(await ctx.actor(), ctx.params.id as string));

	router.get("/api/admin/registration", async (ctx) => registration.getPlatform(await ctx.actor()));
	router.put("/api/admin/registration", async (ctx) => registration.putPlatform(await ctx.actor(), await ctx.json(RegistrationPolicySchema)));
	router.get("/api/orgs/:id/registration", async (ctx) => registration.getOrg(await ctx.actor(), ctx.params.id as string));
	router.put("/api/orgs/:id/registration", async (ctx) => registration.putOrg(await ctx.actor(), ctx.params.id as string, await ctx.json(RegistrationPolicySchema)));

	const readSettings = async () => ({
		allowPersonalTeams: await settings.allowPersonalTeams(),
		allowSelfCreateOrg: await settings.allowSelfCreateOrg(),
		siteName: await settings.siteName(),
		invitationTtlDays: await settings.invitationTtlDays(),
	});
	router.get("/api/admin/settings", async (ctx) => {
		const actor = await ctx.actor();
		if (!can(actor, "platform.manage")) throw forbidden();
		return readSettings();
	});
	router.put("/api/admin/settings", async (ctx) => {
		const actor = await ctx.actor();
		if (!can(actor, "platform.manage")) throw forbidden();
		const body = await ctx.json(SettingsBody);
		await deps.db.tx({ system: true }, async (q) => {
			if (body.allowPersonalTeams !== undefined) await settings.set(q, "allow_personal_teams", body.allowPersonalTeams);
			if (body.allowSelfCreateOrg !== undefined) await settings.set(q, "allow_self_create_org", body.allowSelfCreateOrg);
			if (body.siteName !== undefined) await settings.set(q, "site_name", body.siteName.trim());
			if (body.invitationTtlDays !== undefined) await settings.set(q, "invitation_ttl_days", body.invitationTtlDays);
			await audit.write(q, { actorId: actor.userId, action: "settings.update", targetType: "platform", targetId: "platform", detail: { ...body } });
		});
		return readSettings();
	});

	// Mail server: saved here instead of in the environment so an operator can invite people without touching the host.
	const mail = (): MailSettingsService => deps.registry.require<MailSettingsService>("mailSettings");
	router.get("/api/admin/mail", async (ctx) => mail().view(await ctx.actor()));
	router.put("/api/admin/mail", async (ctx) => mail().save(await ctx.actor(), await ctx.json(MailBody)));
	router.delete("/api/admin/mail", async (ctx) => mail().clear(await ctx.actor()));
	router.post("/api/admin/mail/test", async (ctx) => {
		const body = await ctx.json(MailTestBody);
		return mail().test(await ctx.actor(), body.to, body.config);
	});

	const onboarding = (): OnboardingService => deps.registry.require<OnboardingService>("onboarding");
	router.get("/api/admin/onboarding", async (ctx) => onboarding().status(await ctx.actor()));
	router.put("/api/admin/onboarding", async (ctx) => onboarding().dismiss(await ctx.actor(), (await ctx.json(OnboardingBody)).dismissed));

	router.post("/api/invitations", async (ctx) => new Reply(201, await invitations.create(await ctx.actor(), await ctx.json(InvitationBody), invitesPerDay(deps.config.mode))));

	router.get("/api/orgs", async (ctx) => orgs.list(await ctx.actor()));
	router.post("/api/orgs", async (ctx) => new Reply(201, await deps.registry.require<OrgsPublicService>("orgsPublic").create(await ctx.actor(), await ctx.json(CreateOrgBody))));
	router.get("/api/orgs/:id/members", async (ctx) => orgs.listMembers(await ctx.actor(), ctx.params.id as string));
	router.put("/api/orgs/:id/members/:userId", async (ctx) =>
		orgs.setMember(await ctx.actor(), ctx.params.id as string, ctx.params.userId as string, (await ctx.json(MemberRoleBody)).role),
	);
	router.delete("/api/orgs/:id/members/:userId", async (ctx) => {
		await orgs.removeMember(await ctx.actor(), ctx.params.id as string, ctx.params.userId as string);
		return {};
	});

	router.get("/api/admin/audit", async (ctx) => audit.list(await ctx.actor(), ctx.query(AuditQuery)));
}
