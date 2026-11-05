import { gzipSync } from "node:zlib";
import { errorMessage, LOG, type SessionMapping } from "../types.ts";
import { hubGit, identityOf, type MemberEnv } from "./env.ts";
import { createSnapshotCommit } from "./snapshot.ts";

/** The Hub refuses more than this many base64 characters of transcript. */
export const MAX_TRANSCRIPT_CHARS = 20 * 1024 * 1024;

/** What happens after each finished agent turn: the transcript and a file snapshot go to the Hub. */
export class TurnUploader {
	private readonly env: MemberEnv;

	constructor(env: MemberEnv) {
		this.env = env;
	}

	async run(localSessionId: string, mapping: SessionMapping): Promise<void> {
		await this.uploadTranscript(localSessionId, mapping).catch((err: unknown) => this.env.log.warn(`${LOG} 上传会话转写失败: ${errorMessage(err)}`));
		await this.uploadSnapshot(mapping).catch((err: unknown) => this.env.log.warn(`${LOG} 上传文件快照失败: ${errorMessage(err)}`));
	}

	private async uploadTranscript(localSessionId: string, mapping: SessionMapping): Promise<void> {
		const exported = await this.env.host.sessions.exportTranscript(localSessionId);
		if (!exported) return;
		const content = gzipSync(Buffer.from(exported.content, "utf8")).toString("base64");
		if (content.length > MAX_TRANSCRIPT_CHARS) {
			this.env.log.warn(`${LOG} 会话转写超过 20MB 上限，未上传 (${localSessionId})，该会话无法被完整 fork`);
			return;
		}
		await this.env.client.call("PUT", `/sessions/${mapping.hubSessionId}/transcript`, { format: exported.format, content });
	}

	private async uploadSnapshot(mapping: SessionMapping): Promise<void> {
		const userId = this.env.state.get().userId;
		if (!userId) return;
		const commit = await createSnapshotCommit(mapping.worktree, identityOf(this.env));
		await hubGit(this.env, ["push", "--quiet", "--force", "origin", `${commit}:refs/prometheus/snapshots/${userId}/${mapping.hubSessionId}`], mapping.worktree);
		await this.env.client.call("PATCH", `/sessions/${mapping.hubSessionId}`, { snapshotCommit: commit });
	}
}
