/**
 * What the model must not read. Password fields never reach the host from a driver, but values
 * that merely look like secrets (tokens in a settings page, a one-time code in an SMS app) do, and
 * are masked before anything is rendered or diffed.
 */

const SECRET_PATTERNS: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style keys
	/\bsk-ant-[A-Za-z0-9_-]{16,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
	/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, // Slack
	/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, // JWT
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

const OTP_LABEL = /验证码|校验码|动态码|verification code|security code|one[- ]time|\botp\b|\b2fa\b/i;
const OTP_VALUE = /\b\d{4,8}\b/g;

export const MASK = "••••";

export function redactText(text: string, label = ""): string {
	let out = text;
	for (const re of SECRET_PATTERNS) out = out.replace(re, "[已隐藏密钥]");
	if (OTP_LABEL.test(label) || OTP_LABEL.test(out)) out = out.replace(OTP_VALUE, MASK);
	return out;
}

export function isSecretField(states: readonly string[] | undefined): boolean {
	return !!states?.includes("password");
}
