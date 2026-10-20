import { TEXT as operatorEn } from "./bundled/operator_en.ts";
import { TEXT as researchEn } from "./bundled/research_en.ts";

/**
 * Shipped prompt text, inlined at build time.
 *
 * The desktop bundle is produced by esbuild, which only follows imports: a plain `readFile` on a
 * `.md` next to the source would work in dev and fail in every packaged build. Keeping the text in
 * modules makes it part of whatever bundle ships it.
 */
export const BUNDLED: Record<string, string> = {
	"operator.en.md": operatorEn,
	"research.en.md": researchEn,
};
