// Pure helpers of the billing and BYOK pages: billingDisabled detection, credits and money formatting, form parsing.
import { TeamApiError } from "../api.ts";
import type { OrderStatus } from "../types.ts";

/** The Hub answers user billing routes with 404 `billingDisabled` when billing is off (public mode or HUB_BILLING=on enables it). */
export function isBillingDisabled(err: unknown): boolean {
	return err instanceof TeamApiError && err.code === "billingDisabled";
}

export type BillingProbe = "enabled" | "disabled";

/**
 * Runs the one-time billing probe (any user billing call). Resolves `disabled` only for a definitive billingDisabled
 * answer; any other failure keeps billing visible so the page itself can show the real error.
 */
export async function probeBilling(call: () => Promise<unknown>): Promise<BillingProbe> {
	try {
		await call();
		return "enabled";
	} catch (err) {
		return isBillingDisabled(err) ? "disabled" : "enabled";
	}
}

/** Same bounds as the Hub's top-up checkout (packages/hub/src/billing/orders.ts). */
export const MIN_TOPUP_CREDITS = 1000;
export const MAX_TOPUP_CREDITS = 100_000_000;
export const TOPUP_PRESETS: readonly number[] = [10_000, 50_000, 100_000, 500_000, 1_000_000];

/** Credits as a grouped integer ("12,345"). Non-finite input shows as "0". */
export function formatCredits(value: number, lang: string = "en"): string {
	if (!Number.isFinite(value)) return "0";
	return Math.round(value).toLocaleString(lang === "zh" ? "zh" : "en");
}

/** Compact credits for presets and chips: 10K, 1.5M. Values below 1000 stay whole. */
export function formatCreditsShort(value: number): string {
	if (!Number.isFinite(value)) return "0";
	const abs = Math.abs(value);
	const trim = (n: number) => String(Math.round(n * 10) / 10);
	if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
	if (abs >= 1000) return `${trim(value / 1000)}K`;
	return String(Math.round(value));
}

/** Money from minor units: 1999 + "cny" gives "CNY 19.99". Zero is "0.00" (a free plan reads as "Free" at the call site). */
export function formatMoney(cents: number, currency: string): string {
	const amount = (Number.isFinite(cents) ? cents : 0) / 100;
	return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
}

/** A model price as credits per million tokens, up to 4 decimals without trailing zeros. */
export function formatPrice(value: number): string {
	if (!Number.isFinite(value)) return "0";
	const fixed = value.toFixed(4);
	return fixed.replace(/\.?0+$/, "") || "0";
}

/** Price field text to a non-negative finite number, or undefined when it is not one. */
export function parsePriceInput(text: string): number | undefined {
	const v = text.trim();
	if (!/^\d+(\.\d+)?$/.test(v)) return undefined;
	const n = Number(v);
	return Number.isFinite(n) && n <= 1e12 ? n : undefined;
}

/** Whole credits typed by the user within [min, max]; undefined otherwise. Spaces and thousands commas are tolerated. */
export function parseCreditsInput(text: string, min = 1, max = 1_000_000_000): number | undefined {
	const v = text.trim().replace(/[,\s]/g, "");
	if (!/^\d{1,12}$/.test(v)) return undefined;
	const n = Number(v);
	return n >= min && n <= max ? n : undefined;
}

/** A major-unit amount ("19.9") to cents (1990); undefined for anything but at most two decimals. */
export function parseCentsInput(text: string): number | undefined {
	const v = text.trim();
	if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) return undefined;
	return Math.round(Number(v) * 100);
}

export const centsToInput = (cents: number): string => (cents / 100).toFixed(2);

/** `<input type="datetime-local">` value to an ISO string; empty or invalid gives null. */
export function localInputToIso(text: string): string | null {
	if (!text.trim()) return null;
	const d = new Date(text);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export type StatusTone = "muted" | "ember" | "moss" | "rose" | "sky";

export function orderStatusTone(status: OrderStatus): StatusTone {
	switch (status) {
		case "paid":
			return "moss";
		case "pending":
			return "ember";
		case "failed":
			return "rose";
		case "refunded":
			return "sky";
		default:
			return "muted";
	}
}

/** Operator actions the Hub accepts for a manual order: pending (or failed) to paid, paid to refunded. */
export function manualOrderActions(order: { provider: string; status: OrderStatus }): { markPaid: boolean; markRefunded: boolean } {
	if (order.provider !== "manual") return { markPaid: false, markRefunded: false };
	return { markPaid: order.status === "pending" || order.status === "failed", markRefunded: order.status === "paid" };
}

/** Whether a checkout answer sends the browser away (online provider) or waits for an operator (manual). */
export function checkoutRedirect(redirectUrl: string | null | undefined): string | undefined {
	if (!redirectUrl) return undefined;
	try {
		const u = new URL(redirectUrl);
		return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
	} catch {
		return undefined;
	}
}

/** One code per line, for copy and the .txt download. */
export const codesToText = (codes: readonly string[]): string => `${codes.join("\n")}\n`;

/** Share of a limit used, 0..100, for the balance bar. */
export function percentOf(part: number, whole: number): number {
	if (!(whole > 0) || !(part > 0)) return 0;
	return Math.min(100, Math.round((part / whole) * 100));
}
