import { forbidden } from "../errors.ts";
import { type Actor, can } from "../permissions.ts";
import type { AuditService } from "./audit.ts";
import type { ServiceDeps } from "./common.ts";
import type { Mailer } from "./mailer.ts";
import type { SettingsService } from "./settings.ts";

const DISMISSED_KEY = "onboarding_dismissed";

/** The first-run steps an operator walks through, in the order that makes the next one possible. */
export const ONBOARDING_STEPS = ["publicUrl", "mail", "gateway", "team", "workspace", "invite"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingStatus {
	steps: { id: OnboardingStep; done: boolean }[];
	/** The operator closed the checklist. */
	dismissed: boolean;
}

export interface OnboardingService {
	status(actor: Actor): Promise<OnboardingStatus>;
	dismiss(actor: Actor, dismissed: boolean): Promise<OnboardingStatus>;
}

export interface OnboardingDeps {
	settings: SettingsService;
	audit: AuditService;
	mailer: Mailer;
	publicUrl: string;
}

export function createOnboardingService(deps: ServiceDeps, d: OnboardingDeps): OnboardingService {
	const requireOperator = (actor: Actor): void => {
		if (!can(actor, "platform.manage")) throw forbidden();
	};

	const count = async (q: { query<T>(sql: string, params?: unknown[]): Promise<T[]> }, sql: string): Promise<number> => {
		const rows = await q.query<{ n: string | number }>(sql);
		return Number(rows[0]?.n ?? 0);
	};

	const status = async (): Promise<OnboardingStatus> => {
		const [gateways, teams, workspaces, invites, users, dismissed] = await deps.db.tx({ system: true }, async (q) => [
			await count(q, "SELECT count(*) AS n FROM model_gateways"),
			await count(q, "SELECT count(*) AS n FROM teams"),
			await count(q, "SELECT count(*) AS n FROM workspaces"),
			await count(q, "SELECT count(*) AS n FROM invitations"),
			await count(q, "SELECT count(*) AS n FROM users"),
			(await d.settings.get<boolean | null>(DISMISSED_KEY, q)) === true,
		] as const);
		const done: Record<OnboardingStep, boolean> = {
			publicUrl: d.publicUrl !== "",
			mail: d.mailer.configured,
			gateway: gateways > 0,
			team: teams > 0,
			workspace: workspaces > 0,
			invite: invites > 0 || users > 1,
		};
		return { steps: ONBOARDING_STEPS.map((id) => ({ id, done: done[id] })), dismissed };
	};

	return {
		async status(actor) {
			requireOperator(actor);
			return status();
		},

		async dismiss(actor, dismissed) {
			requireOperator(actor);
			await deps.db.tx({ system: true }, async (q) => {
				await d.settings.set(q, DISMISSED_KEY, dismissed);
				await d.audit.write(q, { actorId: actor.userId, action: "onboarding.dismiss", targetType: "platform", targetId: "onboarding", detail: { dismissed } });
			});
			return status();
		},
	};
}
