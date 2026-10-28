import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { definePlugin } from "@prometheus/plugin-sdk";
import { OPEN_FILE_TOOL } from "@prometheus/protocol";
import { readForViewer, resolveAllowed } from "./files.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");

const GUIDELINES = [
	`Use ${OPEN_FILE_TOOL} to show the user a file in the app's side viewer when they ask to see it or when pointing at a specific spot; it is not needed for reading a file yourself.`,
];

export default definePlugin({
	name: "workbench",
	version: "0.1.0",
	// The side viewer only appears when open_file runs, so switching it off loses nothing else.
	optional: true,
	setup(ctx) {
		const roots = async (extra?: string): Promise<string[]> => {
			const list = (await ctx.workspaces()).map((w) => w.path);
			list.push(ctx.cwd, join(tmpdir(), "prometheus-uploads"));
			if (extra) list.push(extra);
			return list;
		};

		// ---- UI RPCs: these take what the client sends, so every path goes through resolveAllowed. ----
		ctx.rpc("readFile", async (p) => {
			const cwd = str(p.cwd) || ctx.cwd;
			// The session's own folder counts as a root, but only when it is a folder the app knows.
			const known = await roots();
			const real = await resolveAllowed(str(p.path), cwd, known);
			return readForViewer(real);
		});

		// ---- Agent tools ----
		ctx.context.provide(() => ({ static: { guidelines: GUIDELINES } }));

		ctx.tools.register({
			name: OPEN_FILE_TOOL,
			label: "查看文件",
			description: "Show a file in the user's side file viewer, optionally scrolled to a line. Only files inside the project folders can be shown.",
			promptSnippet: `${OPEN_FILE_TOOL}: show a file to the user in the app's side viewer`,
			parameters: Type.Object({
				path: Type.String({ description: "File path, relative to the working directory or absolute" }),
				line: Type.Optional(Type.Integer({ minimum: 1, description: "Line to scroll to and highlight" })),
			}),
			async execute(_id, params, _signal, _update, tctx) {
				const real = await resolveAllowed(params.path, tctx.cwd, await roots(tctx.cwd));
				return { content: [{ type: "text", text: `Opened ${real}${params.line ? ` at line ${params.line}` : ""} in the viewer.` }], details: { path: real, line: params.line } };
			},
		});
	},
});
