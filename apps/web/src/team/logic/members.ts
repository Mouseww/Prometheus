// Pure helpers for adding members to a team.
import { TeamApiError } from "../api.ts";
import type { TeamView } from "../types.ts";

/**
 * Personal teams (no organization) cannot add a user directly: the Hub only accepts invitations for them.
 * Organization teams can add an eligible organization member by email.
 */
export const canAddDirectly = (team: Pick<TeamView, "orgId">): boolean => team.orgId !== null;

/**
 * Direct add answers one uniform 404 for an unknown user, an inactive one and one outside the team's organization,
 * so the UI must not say which. Any other failure is a real error.
 */
export const isIneligibleMember = (err: unknown): boolean => err instanceof TeamApiError && err.status === 404;
