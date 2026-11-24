// First-run checklist for the Hub operator: which step comes next, and whether the list is worth showing at all.
import type { OnboardingStatus, OnboardingStepId } from "../types.ts";

export interface OnboardingProgress {
	done: number;
	total: number;
	/** The first step still open, in the order the Hub lists them. */
	next: OnboardingStepId | undefined;
	complete: boolean;
}

export function onboardingProgress(status: OnboardingStatus): OnboardingProgress {
	const open = status.steps.find((s) => !s.done);
	const done = status.steps.filter((s) => s.done).length;
	return { done, total: status.steps.length, next: open?.id, complete: open === undefined };
}

/**
 * Only the operator of a Hub sees it, and only until they close it. Older Hubs have no checklist, and the member
 * view (no Hub meta) is not where a Hub gets set up.
 */
export function showOnboarding(status: OnboardingStatus | undefined, operator: boolean, inHubUi: boolean): boolean {
	return status !== undefined && operator && inHubUi && !status.dismissed;
}
