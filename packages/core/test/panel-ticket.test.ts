// A plugin panel iframe cannot carry the login cookie in the desktop shell; it loads with a short-lived pass instead.
import { afterEach, describe, expect, it, vi } from "vitest";
import { issuePanelTicket, panelTicketLookup, panelTicketValid } from "../src/downloads.ts";

afterEach(() => vi.useRealTimers());

describe("panel tickets", () => {
	it("accepts an issued pass, more than once", () => {
		const id = issuePanelTicket();
		expect(panelTicketValid(id)).toBe(true);
		expect(panelTicketValid(id)).toBe(true);
	});

	it("binds the pass to the identity of whoever asked for it", () => {
		const alice = issuePanelTicket({ userId: "alice", actsFor: ["o"] });
		expect(panelTicketLookup(alice)).toEqual({ identity: { userId: "alice", actsFor: ["o"] } });
		const machine = issuePanelTicket();
		expect(panelTicketLookup(machine)).toEqual({});
		expect(panelTicketLookup("nope")).toBeUndefined();
		expect(panelTicketLookup(null)).toBeUndefined();
		vi.useFakeTimers();
		const short = issuePanelTicket({ userId: "bob" });
		vi.advanceTimersByTime(61_000);
		expect(panelTicketLookup(short)).toBeUndefined();
	});

	it("rejects unknown, empty and missing passes", () => {
		expect(panelTicketValid("nope")).toBe(false);
		expect(panelTicketValid("")).toBe(false);
		expect(panelTicketValid(null)).toBe(false);
		expect(panelTicketValid(undefined)).toBe(false);
	});

	it("expires after a minute", () => {
		vi.useFakeTimers();
		const id = issuePanelTicket();
		vi.advanceTimersByTime(59_000);
		expect(panelTicketValid(id)).toBe(true);
		vi.advanceTimersByTime(2_000);
		expect(panelTicketValid(id)).toBe(false);
	});
});
