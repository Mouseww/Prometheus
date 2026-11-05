import { gzipSync } from "node:zlib";
import { publishSnapshot } from "../sync/publish.ts";
import { errorMessage, LOG, type SessionMapping } from "../types.ts";
import type { MemberEnv } from "./env.ts";

/** The Hub refuses more than this many base64 characters of transcript. */
export const MAX_TRANSCRIPT_CHARS = 20 * 1024 * 1024;

/** What publishes the files after a turn: the sync manager (which also tells the other side), or a plain push when there is none. */
export interface SnapshotPublisher {
	publish(hubSessionId: string): Promise<string>;
}

/** What happens after each finished agent turn: the transcript and a file snapshot go to the Hub. */
export class TurnUploader {
	private readonly env: MemberEnv;
	private publisher: SnapshotPublisher | undefined;

	constructor(env: MemberEnv) {
		this.env = env;
	}

	/** Routes snapshots through the sync manager so the other side hears about them (block 3B). */
	setPublisher(publisher: SnapshotPublisher): void {
		this.publisher = publisher;
	}

	async run(localSessionId: string, mapping: SessionMapping): Promise<void> {
		// A session whose brain moved to the other side only mirrors: its files belong to the writer there.
		if (mapping.readOnly) return;
		await this.uploadTranscript(localSessionId, mapping).catch((err: unknown) => this.env.log.warn(`${LOG} 上传会话转写失败: ${errorMessage(err)}`));
		await this.uploadSnapshot(mapping).catch((err: unknown) => this.env.log.warn(`${LOG} 上传文件快照失败: ${errorMessage(err)}`));
	}

	/** Uploads the transcript; rejects on failure (a handoff needs it to be there). Sessions with no transcript are skipped. */
	async uploadTranscript(localSessionId: string, mapping: SessionMapping): Promise<void> {
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
		if (this.publisher) {
			await this.publisher.publish(mapping.hubSessionId);
			return;
		}
		await publishSnapshot(this.env, mapping.worktree, mapping.hubSessionId);
	}
}
