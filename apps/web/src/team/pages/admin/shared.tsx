import { useMemo } from "react";
import { isOperator, managedOrgs, useTeam } from "../../context.tsx";
import { type AsyncState, useAsync } from "../../kit.tsx";
import type { OrgSummary } from "../../types.ts";

/** Organizations the viewer may administer: all of them for the operator, owner/admin ones otherwise. */
export function useAdminOrgs(): AsyncState<OrgSummary[]> {
	const { api, me } = useTeam();
	return useAsync(async () => {
		const all = await api.listOrgs();
		if (isOperator(me)) return all;
		const ids = new Set(managedOrgs(me).map((o) => o.id));
		return all.filter((o) => ids.has(o.id));
	}, [api, me]);
}

export function useOrgNames(orgs: OrgSummary[] | undefined): (id: string | null | undefined) => string {
	return useMemo(() => {
		const map = new Map((orgs ?? []).map((o) => [o.id, o.name]));
		return (id) => (id ? (map.get(id) ?? id) : "");
	}, [orgs]);
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
	return (
		<label className="flex items-center gap-2 text-sm">
			<input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-ember-500" />
			{label}
		</label>
	);
}
