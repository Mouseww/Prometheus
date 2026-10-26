import type { ModelRef } from "@prometheus/protocol";

export { slimEvent } from "./agent/pi/events.ts";

export function toModelRef(model: { provider: string; id: string } | undefined | null): ModelRef | null {
	// PI reports a placeholder "unknown" model when nothing is configured.
	if (!model || model.provider === "unknown") return null;
	return { provider: model.provider, id: model.id };
}
