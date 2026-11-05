import { Type } from "typebox";
import type { HubDeps } from "../deps.ts";
import { forbidden } from "../errors.ts";
import { Reply, type Router } from "../http/router.ts";
import { can } from "../permissions.ts";
import { invitesPerDay } from "../services/invitations.ts";
import { lockOutUser } from "../services/lockout.ts";
import type { OrgsPublicService } from "../services/orgs-public.ts";
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
const SettingsBody = Type.Object({ allowPersonalTeams: Type.Optional(Type.Boolean()), allowSelfCreateOrg: Type.Optional(Type.Boolean()) });

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

	router.get("/api/admin/settings", async (ctx) => {
		const actor = await ctx.actor();
		if (!can(actor, "platform.manage")) throw forbidden();
		return { allowPersonalTeams: await settings.allowPersonalTeams(), allowSelfCreateOrg: await settings.allowSelfCreateOrg() };
	});
	router.put("/api/admin/settings", async (ctx) => {
		const actor = await ctx.actor();
		if (!can(actor, "platform.manage")) throw forbidden();
		const body = await ctx.json(SettingsBody);
		await deps.db.tx({ system: true }, async (q) => {
			if (body.allowPersonalTeams !== undefined) await settings.set(q, "allow_personal_teams", body.allowPersonalTeams);
			if (body.allowSelfCreateOrg !== undefined) await settings.set(q, "allow_self_create_org", body.allowSelfCreateOrg);
			await audit.write(q, { actorId: actor.userId, action: "settings.update", targetType: "platform", targetId: "platform", detail: { ...body } });
		});
		return { allowPersonalTeams: await settings.allowPersonalTeams(), allowSelfCreateOrg: await settings.allowSelfCreateOrg() };
	});

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
