import type { SessionSummary, SyncBundle, SyncReport, SyncScope } from "@prometheus/protocol";
import { passwordLogin, targetFromUrl } from "./backend.ts";
import { PrometheusClient } from "./client.ts";
import type { Platform } from "./platforms.ts";

export type SyncDirection = "pull" | "push";

export interface SyncOptions {
	peer: Platform;
	direction: SyncDirection;
	scopes: SyncScope[];
	/** Chats to move; when omitted, chats changed after `since` (at most AUTO_MAX_SESSIONS). */
	sessionIds?: string[];
	since?: number;
	overwrite: boolean;
}

/** An unattended run moves only a handful of chats at a time; the rest follow on the next run. */
export const AUTO_MAX_SESSIONS = 20;

/** A short-lived connection to another platform, signed in with its saved credentials. */
export async function openPeer(p: Platform): Promise<PrometheusClient> {
	let token = p.token;
	if (p.password) {
		const r = await passwordLogin(targetFromUrl(p.url), p.password).catch(() => null);
		if (r?.ok) token = r.token;
	}
	const client = new PrometheusClient(targetFromUrl(p.url, token));
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => done(new Error("timeout")), 15_000);
		const off = client.onState((s) => {
			if (s === "open") done();
			else if (s === "unauthorized") done(new Error("unauthorized"));
		});
		const done = (err?: Error) => {
			clearTimeout(timer);
			off();
			if (err) {
				client.close();
				reject(err);
			} else resolve();
		};
		client.connect();
	});
	return client;
}

const emptyReport = (): SyncReport => ({ gateways: { added: 0, updated: 0, skipped: [] }, settings: false, projects: { added: 0, skipped: [] }, sessions: { added: 0, skipped: [] } });

export function mergeReports(a: SyncReport, b: SyncReport): SyncReport {
	return {
		gateways: { added: a.gateways.added + b.gateways.added, updated: a.gateways.updated + b.gateways.updated, skipped: [...a.gateways.skipped, ...b.gateways.skipped] },
		settings: a.settings || b.settings,
		projects: { added: a.projects.added + b.projects.added, skipped: [...a.projects.skipped, ...b.projects.skipped] },
		sessions: { added: a.sessions.added + b.sessions.added, skipped: [...a.sessions.skipped, ...b.sessions.skipped] },
	};
}

/** Chats the source side could send: not archived, newest first. */
export async function listSourceSessions(source: PrometheusClient): Promise<SessionSummary[]> {
	const r = await source.rpc("sync.export", { scopes: ["sessions"] });
	return (r.sessionList ?? []).filter((s) => !s.archived).sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Copies the chosen parts from one platform to the other. `local` is the connection the app is using. */
export async function runSync(local: PrometheusClient, o: SyncOptions, signal?: { cancelled: boolean }): Promise<SyncReport> {
	const peer = await openPeer(o.peer);
	try {
		const [from, to] = o.direction === "pull" ? [peer, local] : [local, peer];
		const plain = o.scopes.filter((s) => s !== "sessions");
		let report = emptyReport();
		if (plain.length) {
			const { sessionList: _unused, ...bundle } = await from.rpc("sync.export", { scopes: plain });
			report = mergeReports(report, await to.rpc("sync.import", { bundle: bundle as SyncBundle, overwrite: o.overwrite }));
		}
		if (o.scopes.includes("sessions")) {
			let ids = o.sessionIds;
			if (!ids) {
				const since = o.since ?? 0;
				ids = (await listSourceSessions(from)).filter((s) => Date.parse(s.modified) > since).slice(0, AUTO_MAX_SESSIONS).map((s) => s.id);
			}
			// One chat per request: a long conversation is large and the frame size is limited.
			for (const sessionId of ids) {
				if (signal?.cancelled) break;
				try {
					const session = await from.rpc("sync.exportSession", { sessionId });
					report = mergeReports(report, await to.rpc("sync.import", { bundle: { sessions: [session] } }));
				} catch (err) {
					report.sessions.skipped.push({ id: sessionId, reason: err instanceof Error ? err.message : String(err) });
				}
			}
		}
		return report;
	} finally {
		peer.close();
	}
}
