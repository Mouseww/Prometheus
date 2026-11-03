import { PERMISSION_MODES } from "@prometheus/protocol";
import type { RuntimeCapabilities } from "../types.ts";

/** PI supports everything the interface can express. */
export const PI_CAPABILITIES: RuntimeCapabilities = {
	steering: true,
	followUpQueue: true,
	compaction: "manual+auto",
	fork: true,
	treeNavigation: true,
	thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
	images: true,
	liveToolListChange: true,
	systemPromptReplace: "live",
	contextBreakdown: true,
	permissionModes: [...PERMISSION_MODES],
	nativeTools: ["exec", "read", "edit", "write", "search"],
};
