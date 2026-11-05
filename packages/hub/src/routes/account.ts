import { Type } from "typebox";
import type { HubDeps } from "../deps.ts";
import { Reply, type Router } from "../http/router.ts";
import { DisplayNameSchema, EmailSchema, PasswordSchema } from "./schemas.ts";

const RegisterBody = Type.Object({
	email: EmailSchema,
	password: PasswordSchema,
	displayName: DisplayNameSchema,
	setupCode: Type.Optional(Type.String({ maxLength: 64 })),
	inviteToken: Type.Optional(Type.String({ maxLength: 200 })),
	turnstileToken: Type.Optional(Type.String({ maxLength: 2048 })),
});
const LoginBody = Type.Object({ email: EmailSchema, password: Type.String({ minLength: 1, maxLength: 200 }) });
const RefreshBody = Type.Object({ refreshToken: Type.String({ minLength: 1, maxLength: 200 }) });

/** `GET /api/meta`, register/login/refresh/logout, `GET /api/me` and the public invitation lookup. */
export function registerAccountRoutes(router: Router, deps: HubDeps): void {
	const { accounts, invitations } = deps.services;

	router.get("/api/meta", async () => accounts.meta(), { auth: "public" });

	router.post(
		"/api/auth/register",
		async (ctx) => {
			const body = await ctx.json(RegisterBody);
			return new Reply(201, await accounts.register(body, ctx.client));
		},
		{ auth: "public" },
	);

	router.post("/api/auth/login", async (ctx) => accounts.login(await ctx.json(LoginBody), ctx.client), { auth: "public" });

	router.post("/api/auth/refresh", async (ctx) => accounts.refresh((await ctx.json(RefreshBody)).refreshToken, ctx.client), { auth: "public" });

	router.post(
		"/api/auth/logout",
		async (ctx) => {
			await accounts.logout((await ctx.json(RefreshBody)).refreshToken);
			return {};
		},
		{ auth: "public" },
	);

	router.get("/api/me", async (ctx) => accounts.me(await ctx.actor()));

	router.get("/api/invitations/:token", async (ctx) => invitations.lookup(ctx.params.token as string), { auth: "public" });
}
