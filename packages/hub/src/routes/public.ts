import { Type } from "typebox";
import type { HubDeps } from "../deps.ts";
import { tooManyRequests } from "../errors.ts";
import { Reply, type Router } from "../http/router.ts";
import type { AbuseGuard } from "../services/abuse.ts";
import type { PublicAccounts } from "../services/accounts-public.ts";
import type { OrgsPublicService } from "../services/orgs-public.ts";
import type { TransfersService } from "../services/transfers.ts";
import { EmailSchema, IdSchema, PasswordSchema } from "./schemas.ts";

const TokenBody = Type.Object({ token: Type.String({ minLength: 1, maxLength: 200 }) });
const EmailBody = Type.Object({ email: EmailSchema });
const ResetBody = Type.Object({ token: Type.String({ minLength: 1, maxLength: 200 }), password: PasswordSchema });
const DomainBody = Type.Object({ domain: Type.String({ minLength: 3, maxLength: 253, pattern: "^@?[A-Za-z0-9][A-Za-z0-9.-]*\\.[A-Za-z0-9-]+$" }) });
const TransferBody = Type.Object({ orgId: IdSchema });

/**
 * Block 4A: email verification and password reset (both modes), disposable-domain admin, team transfers into an organization,
 * and the operator "运营" additions. The services are built by `createHub` and found in the registry.
 */
export function registerPublicRoutes(router: Router, deps: HubDeps): void {
	const pub = deps.registry.require<PublicAccounts>("publicAccounts");
	const abuse = deps.registry.require<AbuseGuard>("abuse");
	const orgsPublic = deps.registry.require<OrgsPublicService>("orgsPublic");
	const transfers = deps.registry.require<TransfersService>("transfers");

	router.post(
		"/api/auth/verify-email",
		async (ctx) => {
			// Reuses the login throttle so tokens cannot be brute forced.
			const hit = deps.limiter.hit(`verify-email:ip:${ctx.client.ip}`, 20);
			if (!hit.allowed) throw tooManyRequests(hit.retryAfterSec);
			return pub.verifyEmail((await ctx.json(TokenBody)).token);
		},
		{ auth: "public" },
	);
	router.post(
		"/api/auth/resend-verification",
		async (ctx) => {
			await pub.resendVerification((await ctx.json(EmailBody)).email, ctx.client.ip);
			return {};
		},
		{ auth: "public" },
	);
	router.post(
		"/api/auth/forgot-password",
		async (ctx) => {
			await pub.forgotPassword((await ctx.json(EmailBody)).email, ctx.client.ip);
			return {};
		},
		{ auth: "public" },
	);
	router.post(
		"/api/auth/reset-password",
		async (ctx) => {
			const body = await ctx.json(ResetBody);
			await pub.resetPassword(body.token, body.password);
			return {};
		},
		{ auth: "public" },
	);

	router.get("/api/admin/disposable-domains", async (ctx) => abuse.listDomains(await ctx.actor()));
	router.post("/api/admin/disposable-domains", async (ctx) => new Reply(201, await abuse.addDomain(await ctx.actor(), (await ctx.json(DomainBody)).domain)));
	router.delete("/api/admin/disposable-domains/:domain", async (ctx) => {
		await abuse.removeDomain(await ctx.actor(), ctx.params.domain as string);
		return {};
	});

	router.get("/api/admin/orgs", async (ctx) => orgsPublic.listAll(await ctx.actor()));
	router.post("/api/admin/users/:id/ban", async (ctx) => orgsPublic.ban(await ctx.actor(), ctx.params.id as string));

	router.get("/api/transfers", async (ctx) => transfers.list(await ctx.actor()));
	router.post("/api/teams/:id/transfer", async (ctx) => new Reply(201, await transfers.request(await ctx.actor(), ctx.params.id as string, (await ctx.json(TransferBody)).orgId)));
	router.post("/api/transfers/:id/accept", async (ctx) => transfers.accept(await ctx.actor(), ctx.params.id as string));
	router.post("/api/transfers/:id/reject", async (ctx) => transfers.reject(await ctx.actor(), ctx.params.id as string));
	router.post("/api/transfers/:id/cancel", async (ctx) => transfers.cancel(await ctx.actor(), ctx.params.id as string));
}
