import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@prometheus/plugin-sdk";
import { errorMessage, LOG } from "../types.ts";
import type { MemberEnv } from "./env.ts";
import { TOKEN_FILE } from "./hub-client.ts";

export const PROVIDER_NAME = "team";
const SCRIPT_FILE = "print-token.mjs";

interface VisibleModel {
	id: string;
	name: string;
	format: "openai" | "anthropic" | "gemini";
}

const API_OF: Record<VisibleModel["format"], string> = {
	openai: "openai-completions",
	anthropic: "anthropic-messages",
	gemini: "google-generative-ai",
};

/** The command PI runs to read the API key: it prints the access token the plugin keeps fresh in a 0600 file. */
export function tokenCommand(execPath: string, script: string, nonce: number): string | undefined {
	if (execPath.includes('"') || script.includes('"')) return undefined;
	// A desktop host runs inside Electron, whose binary must not be started as a plain script runner: use `node` from PATH there.
	const runner = /^node(\.exe)?$/i.test(basename(execPath)) ? execPath : "node";
	// The trailing number only changes the command text: PI caches a command's output per text, so a new number makes it read the file again.
	return `!"${runner}" "${script}" ${nonce}`;
}

/**
 * Registers a PI provider named `team` that points at the Hub's LLM proxy, so team sessions use the models the administrator
 * configured without any key on the member's machine. Every live extension instance is re-registered when the token or the
 * model list changes.
 */
export class TeamProvider {
	private readonly env: MemberEnv;
	private readonly instances = new Set<ExtensionAPI>();
	private models: VisibleModel[] = [];
	private nonce = 1;
	private readonly execPath: string;

	constructor(env: MemberEnv, execPath = process.execPath) {
		this.env = env;
		this.execPath = execPath;
	}

	get scriptPath(): string {
		return join(this.env.state.dir, SCRIPT_FILE);
	}

	/** The extension contributed through `ctx.extension`. */
	readonly factory: ExtensionFactory = (pi) => {
		this.instances.add(pi);
		this.apply(pi);
	};

	get modelIds(): string[] {
		return this.models.map((m) => m.id);
	}

	private async writeScript(): Promise<void> {
		const tokenFile = join(this.env.state.dir, TOKEN_FILE);
		const source = `import { readFileSync } from "node:fs";\ntry {\n\tprocess.stdout.write(readFileSync(${JSON.stringify(tokenFile)}, "utf8").trim());\n} catch {\n\tprocess.exit(1);\n}\n`;
		await writeFile(this.scriptPath, source, { mode: 0o600 });
	}

	/** Fetches the models the Hub offers this user; an empty list removes the provider. */
	async refreshModels(): Promise<void> {
		const reply = await this.env.client.request<VisibleModel[]>("GET", "/models");
		if (!reply.envelope.ok || !Array.isArray(reply.envelope.data)) {
			this.env.log.warn(`${LOG} 获取团队模型列表失败: ${reply.envelope.error?.message ?? reply.status}`);
			return;
		}
		const seen = new Set<string>();
		this.models = reply.envelope.data.filter((m) => !seen.has(m.id) && (seen.add(m.id), m.format in API_OF));
		if (this.models.length > 0) await this.writeScript();
		this.reapply();
	}

	/** The token file changed: bump the command text and register again so PI reads the new token. */
	onToken(token: string | undefined): void {
		if (token === undefined) {
			this.clear();
			return;
		}
		this.nonce++;
		this.reapply();
	}

	clear(): void {
		this.models = [];
		for (const pi of [...this.instances]) this.safely(pi, () => pi.unregisterProvider(PROVIDER_NAME));
	}

	private reapply(): void {
		for (const pi of [...this.instances]) this.apply(pi);
	}

	private safely(pi: ExtensionAPI, run: () => void): void {
		try {
			run();
		} catch (err) {
			// The session behind this instance is gone.
			this.instances.delete(pi);
			this.env.log.warn(`${LOG} 更新团队模型提供方失败: ${errorMessage(err)}`);
		}
	}

	private apply(pi: ExtensionAPI): void {
		const hubUrl = this.env.client.hubUrl;
		if (this.models.length === 0 || !hubUrl) {
			this.safely(pi, () => pi.unregisterProvider(PROVIDER_NAME));
			return;
		}
		const apiKey = tokenCommand(this.execPath, this.scriptPath, this.nonce);
		if (!apiKey) {
			this.env.log.warn(`${LOG} 数据目录路径含有双引号，无法注册团队模型提供方`);
			return;
		}
		const root = `${hubUrl}/plugins/team/llm`;
		const first = this.models[0] as VisibleModel;
		this.safely(pi, () =>
			pi.registerProvider(PROVIDER_NAME, {
				name: "团队模型",
				baseUrl: `${root}/${first.format}`,
				apiKey,
				models: this.models.map((m) => ({
					id: m.id,
					name: m.name,
					api: API_OF[m.format],
					baseUrl: `${root}/${m.format}`,
					reasoning: false,
					input: ["text", "image"] as ("text" | "image")[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 16_384,
				})),
			}),
		);
	}
}
