import { TEXT as defaultPrompt } from "./bundled/default_en.ts";
import { TEXT as operator } from "./bundled/operator_en.ts";
import { TEXT as research } from "./bundled/research_en.ts";
import { TEXT as whitehat } from "./bundled/whitehat_en.ts";

/**
 * Shipped prompt text, inlined at build time by scripts/embed-prompts.mjs.
 *
 * The desktop bundle is produced by esbuild, which only follows imports: a `readFile` on a `.md`
 * next to the source works in dev and fails in every packaged build.
 */
export const BUNDLED: Record<string, string> = {
	"default.en.md": defaultPrompt,
	"operator.en.md": operator,
	"research.en.md": research,
	"whitehat.en.md": whitehat,
};
