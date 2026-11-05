// Team home: workspace picker plus the daily report | board tabs.
import { LayoutDashboard } from "lucide-react";
import { useState } from "react";
import { Empty, PageHeader, Select } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { isTeamAdmin, useTeam } from "../../context.tsx";
import { AsyncView, Body, Tabs, useAsync } from "../../kit.tsx";
import { HOME_WORKSPACE_KEY, type HomeTab, rememberHomeTab, resolveHomeTab } from "../../logic/homeTab.ts";
import { MemberWorkspaceActions } from "../MemberWorkspaceActions.tsx";
import { BoardTab } from "./BoardTab.tsx";
import { ReportTab } from "./ReportTab.tsx";

const M = defineMessages({
	zh: {
		title: "团队首页",
		workspace: "工作区",
		tabs: "首页内容",
		report: "日报",
		board: "看板",
		noWorkspaces: "还没有工作区",
		noWorkspacesHint: "先在「团队」里加入或创建一个团队，再创建工作区。",
	},
	en: {
		title: "Team home",
		workspace: "Workspace",
		tabs: "Home content",
		report: "Daily report",
		board: "Board",
		noWorkspaces: "No workspaces yet",
		noWorkspacesHint: "Join or create a team under Teams, then create a workspace.",
	},
});

interface WorkspaceOption {
	id: string;
	teamId: string;
	label: string;
	role: string;
}

const readSaved = (): string | null => {
	try {
		return localStorage.getItem(HOME_WORKSPACE_KEY);
	} catch {
		return null;
	}
};

const writeSaved = (id: string): void => {
	try {
		localStorage.setItem(HOME_WORKSPACE_KEY, id);
	} catch {
		/* storage blocked: the pick only lasts for this page */
	}
};

function Home({ options }: { options: WorkspaceOption[] }) {
	const { route } = useTeam();
	const t = useT(M);
	const wanted = route.params?.workspaceId ?? readSaved();
	const [workspaceId, setWorkspaceId] = useState(options.find((o) => o.id === wanted)?.id ?? (options[0] as WorkspaceOption).id);
	const current = options.find((o) => o.id === workspaceId) as WorkspaceOption;
	const [picked, setPicked] = useState<{ ws: string; tab: HomeTab } | undefined>(() => {
		const tab = route.params?.tab;
		return tab === "report" || tab === "board" ? { ws: workspaceId, tab } : undefined;
	});
	const tab: HomeTab = picked && picked.ws === workspaceId ? picked.tab : resolveHomeTab(workspaceId, current.role);

	const pickTab = (next: HomeTab) => {
		rememberHomeTab(workspaceId, next);
		setPicked({ ws: workspaceId, tab: next });
	};

	return (
		<>
			<PageHeader
				title={t("title")}
				actions={
					<Select
						aria-label={t("workspace")}
						value={workspaceId}
						onChange={(e) => {
							setWorkspaceId(e.target.value);
							writeSaved(e.target.value);
						}}
						className="w-56 py-1.5"
					>
						{options.map((o) => (
							<option key={o.id} value={o.id}>
								{o.label}
							</option>
						))}
					</Select>
				}
			/>
			<Body>
				<div className="mb-4">
					<MemberWorkspaceActions workspaceId={workspaceId} />
				</div>
				<Tabs
					label={t("tabs")}
					value={tab}
					onChange={pickTab}
					tabs={[
						{ id: "report", label: t("report") },
						{ id: "board", label: t("board") },
					]}
				/>
				{tab === "report" ? <ReportTab key={workspaceId} workspaceId={workspaceId} canGenerate={isTeamAdmin(current.role)} /> : <BoardTab key={workspaceId} workspaceId={workspaceId} teamId={current.teamId} />}
			</Body>
		</>
	);
}

export function TeamHomePage() {
	const { api } = useTeam();
	const t = useT(M);
	const options = useAsync(async (): Promise<WorkspaceOption[]> => {
		const teams = await api.listTeams();
		const lists = await Promise.all(teams.map(async (team) => ({ team, workspaces: await api.listWorkspaces(team.id) })));
		return lists.flatMap(({ team, workspaces }) => workspaces.map((w) => ({ id: w.id, teamId: team.id, label: `${team.name} / ${w.name}`, role: team.role })));
	}, [api]);

	return (
		<AsyncView state={options}>
			{(list) =>
				list.length === 0 ? (
					<>
						<PageHeader title={t("title")} />
						<Body>
							<Empty icon={<LayoutDashboard className="size-5" />} title={t("noWorkspaces")}>
								{t("noWorkspacesHint")}
							</Empty>
						</Body>
					</>
				) : (
					<Home options={list} />
				)
			}
		</AsyncView>
	);
}
