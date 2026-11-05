import type { PaymentProvider } from "./provider.ts";

/**
 * Offline payment (bank transfer, corporate purchase): the order stays `pending` until an operator confirms the money arrived
 * (`POST /api/admin/orders/:id/mark-paid`). There is no checkout page and no webhook.
 */
export function createManualProvider(): PaymentProvider {
	return {
		id: "manual",
		async createCheckout(order) {
			return { redirectUrl: "", providerRef: order.id };
		},
		parseWebhook() {
			return undefined;
		},
	};
}
