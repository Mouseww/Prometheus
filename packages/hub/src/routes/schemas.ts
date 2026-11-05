import { Type } from "typebox";

export const EmailSchema = Type.String({ minLength: 3, maxLength: 254, pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" });
export const PasswordSchema = Type.String({ minLength: 8, maxLength: 200 });
export const DisplayNameSchema = Type.String({ minLength: 1, maxLength: 100 });
export const NameSchema = Type.String({ minLength: 1, maxLength: 100 });
export const IdSchema = Type.String({ minLength: 1, maxLength: 64 });

export const OrgRoleSchema = Type.Union([Type.Literal("owner"), Type.Literal("admin"), Type.Literal("member")]);
export const TeamRoleSchema = Type.Union([Type.Literal("admin"), Type.Literal("reviewer"), Type.Literal("member")]);

export const RegistrationPolicySchema = Type.Object({
	allowOpen: Type.Boolean(),
	allowedDomains: Type.Array(Type.String({ minLength: 1, maxLength: 253, pattern: "^[A-Za-z0-9.-]+$" }), { maxItems: 100 }),
	requireApproval: Type.Boolean(),
	allowInvite: Type.Boolean(),
	closed: Type.Boolean(),
});
