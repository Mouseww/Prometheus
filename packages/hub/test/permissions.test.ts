import { describe, expect, it } from "vitest";
import { type Action, type Actor, ALL_ACTIONS, can, effectiveTeamRole, type Resource } from "../src/permissions.ts";

const ORG = "org1";
const TEAM = "team1";
const PERSONAL = "pteam";

const actor = (over: Partial<Actor> & { userId: string }): Actor => ({ operator: false, orgRoles: {}, teamRoles: {}, ...over });

const actors: Record<string, Actor> = {
	operator: actor({ userId: "op", operator: true }),
	orgOwner: actor({ userId: "own", orgRoles: { [ORG]: "owner" } }),
	orgAdmin: actor({ userId: "adm", orgRoles: { [ORG]: "admin" } }),
	teamAdmin: actor({ userId: "ta", orgRoles: { [ORG]: "member" }, teamRoles: { [TEAM]: "admin" } }),
	reviewer: actor({ userId: "rv", orgRoles: { [ORG]: "member" }, teamRoles: { [TEAM]: "reviewer" } }),
	member: actor({ userId: "mem", orgRoles: { [ORG]: "member" }, teamRoles: { [TEAM]: "member" } }),
	orgOnly: actor({ userId: "oo", orgRoles: { [ORG]: "member" } }),
	otherOrgAdmin: actor({ userId: "xa", orgRoles: { other: "owner" }, teamRoles: {} }),
	stranger: actor({ userId: "str" }),
};

const orgRes: Resource = { orgId: ORG };
const teamRes: Resource = { orgId: ORG, teamId: TEAM };

/** Expected truth table: actor names allowed per action (everyone else is denied). */
const orgActionAllowed: Partial<Record<Action, string[]>> = {
	"org.view": ["operator", "orgOwner", "orgAdmin", "teamAdmin", "reviewer", "member", "orgOnly"],
	"org.members.view": ["operator", "orgOwner", "orgAdmin", "teamAdmin", "reviewer", "member", "orgOnly"],
	"org.manage": ["operator", "orgOwner", "orgAdmin"],
	"org.members.manage": ["operator", "orgOwner", "orgAdmin"],
	"org.registration.manage": ["operator", "orgOwner", "orgAdmin"],
	"org.users.manage": ["operator", "orgOwner", "orgAdmin"],
	"org.owner.manage": ["operator", "orgOwner"],
	"audit.read": ["operator", "orgOwner", "orgAdmin"],
	"team.create": ["operator", "orgOwner", "orgAdmin"],
};

const teamActionAllowed: Partial<Record<Action, string[]>> = {
	"team.manage": ["operator", "orgOwner", "orgAdmin", "teamAdmin"],
	"workspace.create": ["operator", "orgOwner", "orgAdmin", "teamAdmin"],
	"workspace.manage": ["operator", "orgOwner", "orgAdmin", "teamAdmin"],
	"mr.review": ["operator", "orgOwner", "orgAdmin", "teamAdmin", "reviewer"],
	"mr.skipReview": ["operator", "orgOwner", "orgAdmin", "teamAdmin", "reviewer"],
	"team.view": ["operator", "orgOwner", "orgAdmin", "teamAdmin", "reviewer", "member"],
	"mr.create": ["operator", "orgOwner", "orgAdmin", "teamAdmin", "reviewer", "member"],
	"session.start": ["operator", "orgOwner", "orgAdmin", "teamAdmin", "reviewer", "member"],
	"session.spectate": ["operator", "orgOwner", "orgAdmin", "teamAdmin", "reviewer", "member"],
	"session.fork": ["operator", "orgOwner", "orgAdmin", "teamAdmin", "reviewer", "member"],
};

describe("permission matrix: organization actions", () => {
	for (const [action, allowed] of Object.entries(orgActionAllowed) as [Action, string[]][]) {
		for (const [name, a] of Object.entries(actors)) {
			it(`${action} / ${name} -> ${allowed.includes(name)}`, () => {
				expect(can(a, action, orgRes)).toBe(allowed.includes(name));
			});
		}
	}
});

describe("permission matrix: team actions on an organization team", () => {
	for (const [action, allowed] of Object.entries(teamActionAllowed) as [Action, string[]][]) {
		for (const [name, a] of Object.entries(actors)) {
			it(`${action} / ${name} -> ${allowed.includes(name)}`, () => {
				expect(can(a, action, teamRes)).toBe(allowed.includes(name));
			});
		}
	}
});

describe("permission matrix: platform scope", () => {
	for (const action of ["platform.manage", "org.create"] as const) {
		for (const [name, a] of Object.entries(actors)) {
			it(`${action} / ${name}`, () => {
				expect(can(a, action)).toBe(name === "operator");
			});
		}
	}
	it("audit.read without an org is operator only", () => {
		for (const [name, a] of Object.entries(actors)) expect(can(a, "audit.read", {})).toBe(name === "operator");
	});
});

describe("team creation", () => {
	it("organization teams need org owner/admin", () => {
		expect(can(actors.orgAdmin as Actor, "team.create", { orgId: ORG })).toBe(true);
		expect(can(actors.member as Actor, "team.create", { orgId: ORG })).toBe(false);
		expect(can(actors.otherOrgAdmin as Actor, "team.create", { orgId: ORG })).toBe(false);
	});
	it("personal teams follow allow_personal_teams, operator bypasses", () => {
		expect(can(actors.stranger as Actor, "team.create", { orgId: null, allowPersonalTeams: false })).toBe(false);
		expect(can(actors.stranger as Actor, "team.create", { orgId: null })).toBe(false);
		expect(can(actors.stranger as Actor, "team.create", { orgId: null, allowPersonalTeams: true })).toBe(true);
		expect(can(actors.operator as Actor, "team.create", { orgId: null, allowPersonalTeams: false })).toBe(true);
	});
});

describe("personal teams", () => {
	const owner = actor({ userId: "po", teamRoles: { [PERSONAL]: "admin" } });
	const res: Resource = { orgId: null, teamId: PERSONAL };
	it("rely on explicit team roles only", () => {
		expect(can(owner, "workspace.create", res)).toBe(true);
		expect(can(owner, "mr.review", res)).toBe(true);
		expect(can(actors.stranger as Actor, "team.view", res)).toBe(false);
		// An org admin elsewhere gains nothing on a personal team.
		expect(can(actors.orgOwner as Actor, "team.view", res)).toBe(false);
	});
});

describe("session.grant", () => {
	it("is only for the session owner, even for operators and org admins", () => {
		const res: Resource = { orgId: ORG, teamId: TEAM, ownerUserId: "mem" };
		for (const [name, a] of Object.entries(actors)) expect(can(a, "session.grant", res)).toBe(name === "member");
		expect(can(actors.member as Actor, "session.grant", {})).toBe(false);
	});
});

describe("cross-organization isolation", () => {
	it("an admin of another org has no rights on this org's teams", () => {
		for (const action of ALL_ACTIONS.filter((x) => x !== "team.create" && x !== "org.create" && x !== "platform.manage" && x !== "session.grant")) {
			expect(can(actors.otherOrgAdmin as Actor, action, teamRes)).toBe(false);
		}
	});
});

describe("effectiveTeamRole", () => {
	it("derives implicit admin", () => {
		expect(effectiveTeamRole(actors.operator as Actor, teamRes)).toBe("admin");
		expect(effectiveTeamRole(actors.orgAdmin as Actor, teamRes)).toBe("admin");
		expect(effectiveTeamRole(actors.reviewer as Actor, teamRes)).toBe("reviewer");
		expect(effectiveTeamRole(actors.orgOnly as Actor, teamRes)).toBeUndefined();
	});
});

describe("coverage", () => {
	it("every action appears in the tables or a dedicated test", () => {
		const covered = new Set<string>([
			...Object.keys(orgActionAllowed),
			...Object.keys(teamActionAllowed),
			"platform.manage",
			"org.create",
			"session.grant",
		]);
		expect(ALL_ACTIONS.filter((a) => !covered.has(a))).toEqual([]);
	});
});
