import { describe, expect, it } from "vitest";
import { UIBridge } from "../src/ui-bridge.ts";

function bridge() {
	const requests: string[] = [];
	const ui = new UIBridge({
		request: (r) => requests.push(r.method),
		resolved: () => {},
	});
	return { ui, requests };
}

describe("UIBridge auto mode", () => {
	it("selects the first option and confirms without opening a dialog", async () => {
		const { ui, requests } = bridge();
		ui.auto = true;
		const ctx = ui.context();
		await expect(ctx.select("Pick", ["left", "right"])).resolves.toBe("left");
		await expect(ctx.confirm("Go?", "really")).resolves.toBe(true);
		expect(requests).toEqual([]);
	});

	it("still asks for free text", async () => {
		const { ui, requests } = bridge();
		ui.auto = true;
		const pending = ui.context().input("Name");
		expect(requests).toEqual(["input"]);
		const id = ui.pendingRequests()[0]?.id;
		expect(id).toBeTruthy();
		ui.respond(id!, { value: "Ada" });
		await expect(pending).resolves.toBe("Ada");
	});

	it("resolves a waiting select when auto is switched on", async () => {
		const { ui } = bridge();
		const pending = ui.context().select("Pick", ["first", "second"]);
		expect(ui.pendingRequests()).toHaveLength(1);
		ui.auto = true;
		ui.autoResolvePending();
		await expect(pending).resolves.toBe("first");
		expect(ui.pendingRequests()).toHaveLength(0);
	});

	it("headless still cancels instead of auto-picking", async () => {
		const { ui, requests } = bridge();
		ui.headless = true;
		ui.auto = true;
		await expect(ui.context().select("Pick", ["left"])).resolves.toBeUndefined();
		await expect(ui.context().confirm("Go?", "x")).resolves.toBe(false);
		expect(requests).toEqual([]);
	});
});
