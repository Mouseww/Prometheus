import { TEXT as acceptEdits } from "./bundled/accept-edits_en.ts";
import { TEXT as defaultMode } from "./bundled/default_en.ts";
import { TEXT as operator } from "./bundled/operator_en.ts";
import { TEXT as plan } from "./bundled/plan_en.ts";
import { TEXT as whitehat } from "./bundled/whitehat_en.ts";

/**
 * Shipped prompt text, inlined at build time by scripts/embed-prompts.mjs.
 *
 * The desktop bundle is produced by esbuild, which only follows imports: a `readFile` on a `.md`
 * next to the source works in dev and fails in every packaged build.
 */
export const BUNDLED: Record<string, string> = {
	"accept-edits.en.md": acceptEdits,
	"default.en.md": defaultMode,
	"operator.en.md": operator,
	"plan.en.md": plan,
	"whitehat.en.md": whitehat,
};
