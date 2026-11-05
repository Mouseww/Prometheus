import { Type } from "typebox";
import type { HubDeps } from "../deps.ts";
import { badRequest } from "../errors.ts";
import { Reply, type Router } from "../http/router.ts";
import { EmailSchema, IdSchema, NameSchema, TeamRoleSchema } from "./schemas.ts";

const CreateTeamBody = Type.Object({ name: NameSchema, orgId: Type.Optional(Type.Union([IdSchema, Type.Null()])) });
const AddMemberBody = Type.Object({ userId: Type.Optional(IdSchema), email: Type.Optional(EmailSchema), role: TeamRoleSchema });
const RoleBody = Type.Object({ role: TeamRoleSchema });

/** Team and team member endpoints (workspaces under teams belong to block 2B). */
export function registerTeamRoutes(router: Router, deps: HubDeps): void {
	const { teams } = deps.services;

	router.get("/api/teams", async (ctx) => teams.listFor(await ctx.actor()));
	router.post("/api/teams", async (ctx) => new Reply(201, await teams.create(await ctx.actor(), await ctx.json(CreateTeamBody))));

	router.get("/api/teams/:id/members", async (ctx) => teams.listMembers(await ctx.actor(), ctx.params.id as string));
	router.post("/api/teams/:id/members", async (ctx) => {
		const body = await ctx.json(AddMemberBody);
		if (!body.userId && !body.email) throw badRequest("需要 userId 或 email", "validationError");
		return new Reply(201, await teams.addMember(await ctx.actor(), ctx.params.id as string, body));
	});
	router.put("/api/teams/:id/members/:userId", async (ctx) =>
		teams.setMemberRole(await ctx.actor(), ctx.params.id as string, ctx.params.userId as string, (await ctx.json(RoleBody)).role),
	);
	router.delete("/api/teams/:id/members/:userId", async (ctx) => {
		await teams.removeMember(await ctx.actor(), ctx.params.id as string, ctx.params.userId as string);
		return {};
	});
}
