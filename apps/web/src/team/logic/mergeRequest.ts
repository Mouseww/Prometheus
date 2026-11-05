// Pure helpers for the merge request page.
import { TeamApiError } from "../api.ts";

/** The approve call carries the head the reviewer saw; the Hub answers 409 `headChanged` when the branch moved since. */
export const isHeadChanged = (err: unknown): boolean => err instanceof TeamApiError && err.code === "headChanged";
