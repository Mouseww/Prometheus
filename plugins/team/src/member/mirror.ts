import type { SessionEvent, UIRequest } from "@prometheus/protocol";
import { errorMessage, LOG, type SessionMapping } from "../types.ts";
import { BLOCKING_METHODS, condense, summarizeRequest } from "./condense.ts";
import type { MemberEnv } from "./env.ts";
import type { TurnUploader } from "./turn-upload.ts";

export const FLUSH_INTERVAL_MS = 500;
export const FLUSH_BATCH = 50;
const MAX_QUEUE = 5000;
const MAX_RETRY_MS = 30_000;

type Status = "running" | "waiting" | "idle";

interface Queued {
	seq: number;
	kind: string;
	payload: Record<string, unknown>;
}

interface Channel {
	queue: Queued[];
	nextSeq: number;
	timer: NodeJS.Timeout | undefined;
	failures: number;
	flushing: Promise<void> | undefined;
	turns: Promise<void>;
	agentRunning: boolean;
	pending: Set<string>;
	syncedStatus: Status | undefined;
	title: string | undefined;
	syncedTitle: string | undefined;
}

export interface MirrorOptions {
	flushIntervalMs?: number;
	batchSize?: number;
}

/**
 * Mirrors the sessions listed in the member's mapping table to the Hub: condensed events in batches with a persisted sequence
 * number, the session status, and (after each finished turn) the transcript and a file snapshot. Sessions outside the
 * mapping are ignored completely.
 */
export class SessionMirror {
	private readonly env: MemberEnv;
	private readonly uploader: Pick<TurnUploader, "run">;
	private readonly interval: number;
	private readonly batch: number;
	private readonly channels = new Map<string, Channel>();
	private disposed = false;

	constructor(env: MemberEnv, uploader: Pick<TurnUploader, "run">, options: MirrorOptions = {}) {
		this.env = env;
		this.uploader = uploader;
		this.interval = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
		this.batch = options.batchSize ?? FLUSH_BATCH;
	}

	private mapping(localId: string): SessionMapping | undefined {
		if (!this.env.client.loggedIn) return undefined;
		return this.env.state.get().sessions[localId];
	}

	private channel(localId: string): Channel | undefined {
		const mapping = this.mapping(localId);
		if (!mapping || this.disposed) return undefined;
		let ch = this.channels.get(localId);
		if (!ch) {
			ch = {
				queue: [],
				nextSeq: mapping.nextSeq ?? 0,
				timer: undefined,
				failures: 0,
				flushing: undefined,
				turns: Promise.resolve(),
				agentRunning: false,
				pending: new Set(),
				syncedStatus: undefined,
				title: undefined,
				syncedTitle: undefined,
			};
			this.channels.set(localId, ch);
		}
		return ch;
	}

	onSession(localId: string, event: SessionEvent): void {
		const ch = this.channel(localId);
		if (!ch) return;
		if (event.type === "agent_start") ch.agentRunning = true;
		if (event.type === "agent_end") ch.agentRunning = false;
		if (event.type === "session_info_changed" && event.name) ch.title = event.name;
		const out = condense(event);
		if (!out) return;
		this.enqueue(localId, ch, out.kind, out.payload);
		if (event.type === "agent_end" && !event.willRetry) {
			ch.turns = ch.turns
				.then(async () => {
					await this.flush(localId);
					const mapping = this.mapping(localId);
					if (mapping) await this.uploader.run(localId, mapping);
				})
				.catch((err: unknown) => this.env.log.warn(`${LOG} 回合结束后的上传失败: ${errorMessage(err)}`));
		}
	}

	onUiRequest(localId: string, request: UIRequest): void {
		if (!BLOCKING_METHODS.has(request.method)) return;
		const ch = this.channel(localId);
		if (!ch) return;
		ch.pending.add(request.id);
		this.enqueue(localId, ch, "ui_request", summarizeRequest(request));
	}

	onUiResolved(localId: string, requestId: string): void {
		const ch = this.channel(localId);
		if (!ch || !ch.pending.delete(requestId)) return;
		this.enqueue(localId, ch, "ui_resolved", { requestId });
	}

	private enqueue(localId: string, ch: Channel, kind: string, payload: Record<string, unknown>): void {
		ch.queue.push({ seq: ch.nextSeq++, kind, payload });
		if (ch.queue.length > MAX_QUEUE) ch.queue.splice(0, ch.queue.length - MAX_QUEUE);
		if (ch.queue.length >= this.batch) {
			void this.flush(localId);
			return;
		}
		this.arm(localId, ch, this.interval);
	}

	private arm(localId: string, ch: Channel, delay: number): void {
		if (ch.timer || this.disposed) return;
		ch.timer = setTimeout(() => {
			ch.timer = undefined;
			void this.flush(localId);
		}, delay);
		ch.timer.unref();
	}

	private status(ch: Channel): Status {
		return ch.pending.size > 0 ? "waiting" : ch.agentRunning ? "running" : "idle";
	}

	/** Uploads everything queued for the session (one request at a time) and brings status and title up to date. */
	flush(localId: string): Promise<void> {
		const ch = this.channels.get(localId);
		if (!ch) return Promise.resolve();
		if (ch.timer) {
			clearTimeout(ch.timer);
			ch.timer = undefined;
		}
		const run = async (): Promise<void> => {
			const mapping = this.mapping(localId);
			if (!mapping) return;
			while (ch.queue.length > 0) {
				const batch = ch.queue.slice(0, this.batch);
				const reply = await this.env.client.request("POST", `/sessions/${mapping.hubSessionId}/events`, { events: batch });
				if (!reply.envelope.ok) {
					const status = reply.status;
					// A rejected batch (validation, permission, unknown session) will never succeed: drop it. Anything else is retried.
					if (status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429) {
						this.env.log.warn(`${LOG} Hub 拒绝了事件批次，已丢弃 ${batch.length} 条: ${reply.envelope.error?.message ?? status}`);
						ch.queue.splice(0, batch.length);
						continue;
					}
					ch.failures++;
					this.arm(localId, ch, Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.min(ch.failures, 5)));
					return;
				}
				ch.failures = 0;
				ch.queue.splice(0, batch.length);
				const next = (batch[batch.length - 1] as Queued).seq + 1;
				await this.env.state.update((s) => {
					const current = s.sessions[localId];
					return current ? { ...s, sessions: { ...s.sessions, [localId]: { ...current, nextSeq: next } } } : s;
				});
			}
			await this.syncStatus(localId, ch, mapping);
		};
		ch.flushing = (ch.flushing ?? Promise.resolve())
			.then(run)
			.catch((err: unknown) => {
				this.env.log.warn(`${LOG} 上传会话事件失败: ${errorMessage(err)}`);
				ch.failures++;
				this.arm(localId, ch, Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.min(ch.failures, 5)));
			});
		return ch.flushing;
	}

	private async syncStatus(localId: string, ch: Channel, mapping: SessionMapping): Promise<void> {
		const status = this.status(ch);
		const body: Record<string, unknown> = {};
		if (status !== ch.syncedStatus) body.status = status;
		if (ch.title !== undefined && ch.title !== ch.syncedTitle) body.title = ch.title;
		if (Object.keys(body).length === 0) return;
		const reply = await this.env.client.request("PATCH", `/sessions/${mapping.hubSessionId}`, body);
		if (reply.envelope.ok) {
			ch.syncedStatus = status;
			ch.syncedTitle = ch.title;
		} else {
			this.env.log.warn(`${LOG} 更新会话状态失败 (${localId}): ${reply.envelope.error?.message ?? reply.status}`);
		}
	}

	/** Resolves when every queued event, status update and per-turn upload has been handled (tests, shutdown). */
	async idle(): Promise<void> {
		for (let round = 0; round < 5; round++) {
			for (const [id, ch] of this.channels) {
				if (ch.queue.length > 0) await this.flush(id);
				await ch.flushing;
				await ch.turns;
			}
			if ([...this.channels.values()].every((ch) => ch.queue.length === 0 && !ch.timer)) return;
		}
	}

	/** Stops watching a session (it left the mapping). */
	forget(localId: string): void {
		const ch = this.channels.get(localId);
		if (ch?.timer) clearTimeout(ch.timer);
		this.channels.delete(localId);
	}

	dispose(): void {
		this.disposed = true;
		for (const ch of this.channels.values()) if (ch.timer) clearTimeout(ch.timer);
		this.channels.clear();
	}
}
