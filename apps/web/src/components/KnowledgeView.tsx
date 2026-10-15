import { BookOpen, FileText, Plus, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { GatewayConfig, KnowledgeBaseInfo, KnowledgeDocumentInfo, KnowledgeHit } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { call, toast } from "../lib/store.ts";
import { Badge, Button, Empty, Field, Input, PageHeader, Select, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "知识库",
		subtitle: "文档切分、向量化后由 Agent 通过 knowledge_search 工具自主检索",
		newBase: "新建知识库",
		baseStats: "{docs} 文档 · {chunks} 片段 · {store}",
		noBases: "暂无知识库",
		emptyTitle: "创建你的第一个知识库",
		emptyBody: "需要一个 OpenAI 或 Gemini 格式的网关来生成 Embedding。",
		name: "名称",
		namePlaceholder: "产品文档",
		description: "描述",
		descriptionHint: "会告知 Agent，帮助它判断何时检索",
		descriptionPlaceholder: "公司产品手册与 FAQ",
		embeddingGateway: "Embedding 网关",
		noGateway: "请先添加 OpenAI/Gemini 网关",
		embeddingModel: "Embedding 模型",
		vectorStore: "向量存储",
		vectorStoreHint: "插件可注册更多存储后端",
		cancel: "取消",
		create: "创建",
		embedding: "正在向量化：{title}",
		ingested: "已入库「{title}」，{n} 个片段",
		unsupported: "暂不支持的文件类型：{name}",
		tooLarge: "文件过大：{name}",
		confirmDelete: "删除知识库「{name}」及其全部向量数据？",
		dropHint: "拖拽文本文件到这里，或",
		pickFiles: "选择文件",
		supported: "支持 Markdown、纯文本与常见代码文件，单文件 ≤ 5MB",
		pasteText: "粘贴文本入库",
		pasteTitle: "标题",
		pasteBody: "正文…",
		pastedDefault: "粘贴文本",
		ingest: "入库",
		searchTest: "检索测试",
		searchPlaceholder: "输入问题，查看召回的片段",
		noHits: "没有召回结果",
		documents: "文档 · {n}",
		noDocs: "还没有文档",
		chunks: "{n} 片段",
		deleteDoc: "删除文档",
	},
	en: {
		title: "Knowledge",
		subtitle: "Documents are chunked and embedded, then retrieved by the agent via the knowledge_search tool",
		newBase: "New knowledge base",
		baseStats: "{docs} docs · {chunks} chunks · {store}",
		noBases: "No knowledge bases",
		emptyTitle: "Create your first knowledge base",
		emptyBody: "An OpenAI or Gemini format gateway is required to generate embeddings.",
		name: "Name",
		namePlaceholder: "Product docs",
		description: "Description",
		descriptionHint: "Shown to the agent to help it decide when to search",
		descriptionPlaceholder: "Company product manual and FAQ",
		embeddingGateway: "Embedding gateway",
		noGateway: "Add an OpenAI/Gemini gateway first",
		embeddingModel: "Embedding model",
		vectorStore: "Vector store",
		vectorStoreHint: "Plugins can register more storage backends",
		cancel: "Cancel",
		create: "Create",
		embedding: "Embedding: {title}",
		ingested: "Added \"{title}\", {n} chunks",
		unsupported: "Unsupported file type: {name}",
		tooLarge: "File too large: {name}",
		confirmDelete: "Delete knowledge base \"{name}\" and all its vectors?",
		dropHint: "Drop text files here, or",
		pickFiles: "Choose files",
		supported: "Markdown, plain text and common code files, up to 5MB each",
		pasteText: "Paste text",
		pasteTitle: "Title",
		pasteBody: "Content…",
		pastedDefault: "Pasted text",
		ingest: "Add",
		searchTest: "Search test",
		searchPlaceholder: "Ask a question to see which chunks are retrieved",
		noHits: "No results",
		documents: "Documents · {n}",
		noDocs: "No documents yet",
		chunks: "{n} chunks",
		deleteDoc: "Delete document",
	},
});

const TEXT_EXT = /\.(md|markdown|txt|rst|json|ya?ml|toml|csv|html?|xml|js|jsx|ts|tsx|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|sh|ps1|sql|ini|cfg|log)$/i;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function KnowledgeView() {
	const t = useT(M);
	const [bases, setBases] = useState<KnowledgeBaseInfo[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	const load = async () => {
		const list = await call((c) => c.rpc("kb.list", {}));
		if (list) {
			setBases(list);
			setSelected((s) => s ?? list[0]?.id ?? null);
		}
	};
	useEffect(() => {
		void load();
	}, []);

	const current = bases.find((b) => b.id === selected);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<Button variant="primary" onClick={() => setCreating(true)}>
						<Plus className="size-4" /> {t("newBase")}
					</Button>
				}
			/>
			<div className="flex min-h-0 flex-1">
				<div className="w-72 shrink-0 space-y-1 overflow-y-auto border-r hairline p-3">
					{bases.map((b) => (
						<button
							key={b.id}
							type="button"
							onClick={() => {
								setSelected(b.id);
								setCreating(false);
							}}
							className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors ${b.id === selected && !creating ? "bg-ink-850" : "hover:bg-ink-900"}`}
						>
							<div className="truncate text-sm font-medium text-ink-100">{b.name}</div>
							<div className="mt-0.5 text-[11px] text-ink-500">
								{t("baseStats", { docs: b.documentCount, chunks: b.chunkCount, store: b.store })}
							</div>
						</button>
					))}
					{bases.length === 0 && <p className="px-3 py-4 text-sm text-ink-500">{t("noBases")}</p>}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{creating ? (
						<CreateBase
							onDone={async (id) => {
								setCreating(false);
								await load();
								if (id) setSelected(id);
							}}
						/>
					) : current ? (
						<BaseDetail key={current.id} base={current} onChanged={load} />
					) : (
						<Empty icon={<BookOpen className="size-5" />} title={t("emptyTitle")}>
							{t("emptyBody")}
						</Empty>
					)}
				</div>
			</div>
		</div>
	);
}

function CreateBase({ onDone }: { onDone: (id?: string) => void }) {
	const t = useT(M);
	const [gateways, setGateways] = useState<GatewayConfig[]>([]);
	const [stores, setStores] = useState<string[]>([]);
	const [form, setForm] = useState({ name: "", description: "", gatewayId: "", model: "text-embedding-3-small", store: "lancedb" });

	useEffect(() => {
		void call((c) => c.rpc("gateway.list", {})).then((list) => {
			const usable = (list ?? []).filter((g) => g.format !== "anthropic-messages");
			setGateways(usable);
			if (usable[0]) setForm((f) => ({ ...f, gatewayId: usable[0]?.id ?? "" }));
		});
		void call((c) => c.rpc("kb.stores", {})).then((s) => s && setStores(s));
	}, []);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		const info = await call((c) =>
			c.rpc("kb.create", { name: form.name, description: form.description, store: form.store, embedding: { gatewayId: form.gatewayId, model: form.model } }),
		);
		if (info) onDone(info.id);
	};

	return (
		<form onSubmit={submit} className="mx-auto max-w-xl animate-rise space-y-5 p-8">
			<h2 className="font-display text-xl font-semibold">{t("newBase")}</h2>
			<Field label={t("name")}>
				<Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("namePlaceholder")} />
			</Field>
			<Field label={t("description")} hint={t("descriptionHint")}>
				<Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t("descriptionPlaceholder")} />
			</Field>
			<div className="grid gap-4 sm:grid-cols-2">
				<Field label={t("embeddingGateway")}>
					<Select required value={form.gatewayId} onChange={(e) => setForm({ ...form, gatewayId: e.target.value })}>
						{gateways.length === 0 && <option value="">{t("noGateway")}</option>}
						{gateways.map((g) => (
							<option key={g.id} value={g.id}>
								{g.name}
							</option>
						))}
					</Select>
				</Field>
				<Field label={t("embeddingModel")}>
					<Input required value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className="font-mono" />
				</Field>
			</div>
			<Field label={t("vectorStore")} hint={t("vectorStoreHint")}>
				<Select value={form.store} onChange={(e) => setForm({ ...form, store: e.target.value })}>
					{stores.map((s) => (
						<option key={s} value={s}>
							{s}
						</option>
					))}
				</Select>
			</Field>
			<div className="flex justify-end gap-2">
				<Button variant="outline" onClick={() => onDone()}>
					{t("cancel")}
				</Button>
				<Button type="submit" variant="primary" disabled={!form.gatewayId}>
					{t("create")}
				</Button>
			</div>
		</form>
	);
}

function BaseDetail({ base, onChanged }: { base: KnowledgeBaseInfo; onChanged: () => Promise<void> }) {
	const t = useT(M);
	const [docs, setDocs] = useState<KnowledgeDocumentInfo[]>([]);
	const [busy, setBusy] = useState<string | null>(null);
	const [paste, setPaste] = useState({ title: "", text: "" });
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	const loadDocs = async () => {
		const list = await call((c) => c.rpc("kb.documents", { id: base.id }));
		if (list) setDocs(list);
	};
	useEffect(() => {
		void loadDocs();
	}, [base.id]);

	const ingest = async (title: string, text: string) => {
		setBusy(t("embedding", { title }));
		const doc = await call((c) => c.rpc("kb.ingest", { id: base.id, title, text }));
		setBusy(null);
		if (doc) {
			toast(t("ingested", { title, n: doc.chunks }));
			await Promise.all([loadDocs(), onChanged()]);
		}
		return Boolean(doc);
	};

	const onFiles = async (files: FileList | null) => {
		for (const file of Array.from(files ?? [])) {
			if (!TEXT_EXT.test(file.name)) {
				toast(t("unsupported", { name: file.name }), "warning");
				continue;
			}
			if (file.size > MAX_FILE_BYTES) {
				toast(t("tooLarge", { name: file.name }), "warning");
				continue;
			}
			await ingest(file.name, await file.text());
		}
		if (fileInput.current) fileInput.current.value = "";
	};

	const search = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!query.trim()) return;
		const result = await call((c) => c.rpc("kb.search", { id: base.id, query, topK: 6 }));
		if (result) setHits(result);
	};

	const removeBase = async () => {
		if (!confirm(t("confirmDelete", { name: base.name }))) return;
		const ok = await call((c) => c.rpc("kb.delete", { id: base.id }));
		if (ok !== undefined) await onChanged();
	};

	return (
		<div className="mx-auto max-w-3xl space-y-8 p-8">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h2 className="font-display text-2xl font-semibold">{base.name}</h2>
					{base.description && <p className="mt-1 text-sm text-ink-400">{base.description}</p>}
					<div className="mt-3 flex flex-wrap gap-1.5">
						<Badge tone="ember">{base.store}</Badge>
						<Badge tone="sky">
							{base.embedding.gatewayId}/{base.embedding.model}
						</Badge>
						<Badge>{base.id}</Badge>
					</div>
				</div>
				<Button variant="danger" onClick={() => void removeBase()}>
					<Trash2 className="size-4" />
				</Button>
			</div>

			<section
				onDragOver={(e) => e.preventDefault()}
				onDrop={(e) => {
					e.preventDefault();
					void onFiles(e.dataTransfer.files);
				}}
				className="rounded-2xl border border-dashed border-ink-700 bg-ink-900/40 p-6 text-center"
			>
				<Upload className="mx-auto size-6 text-ember-400" />
				<p className="mt-2 text-sm text-ink-300">{t("dropHint")}</p>
				<Button variant="outline" className="mt-3" onClick={() => fileInput.current?.click()} disabled={Boolean(busy)}>
					{t("pickFiles")}
				</Button>
				<input ref={fileInput} type="file" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
				<p className="mt-2 text-xs text-ink-500">{t("supported")}</p>
				{busy && <p className="mt-3 animate-pulse text-sm text-ember-300">{busy}</p>}
			</section>

			<details className="rounded-xl border border-ink-800 bg-ink-900/40 p-4">
				<summary className="cursor-pointer text-sm text-ink-300">{t("pasteText")}</summary>
				<div className="mt-4 space-y-3">
					<Input value={paste.title} onChange={(e) => setPaste({ ...paste, title: e.target.value })} placeholder={t("pasteTitle")} />
					<Textarea rows={6} value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} placeholder={t("pasteBody")} />
					<div className="flex justify-end">
						<Button
							variant="primary"
							disabled={!paste.text.trim() || Boolean(busy)}
							onClick={async () => {
								if (await ingest(paste.title || t("pastedDefault"), paste.text)) setPaste({ title: "", text: "" });
							}}
						>
							{t("ingest")}
						</Button>
					</div>
				</div>
			</details>

			<section>
				<h3 className="mb-3 font-mono text-[10.5px] tracking-widest text-ink-500 uppercase">{t("searchTest")}</h3>
				<form onSubmit={search} className="flex gap-2">
					<Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} />
					<Button type="submit" variant="outline">
						<Search className="size-4" />
					</Button>
				</form>
				{hits && (
					<div className="mt-3 space-y-2">
						{hits.length === 0 && <p className="text-sm text-ink-500">{t("noHits")}</p>}
						{hits.map((h, i) => (
							<div key={i} className="rounded-lg border border-ink-800 bg-ink-900/60 p-3">
								<div className="mb-1.5 flex items-center gap-2 text-xs">
									<span className="font-medium text-ink-200">{h.title}</span>
									<span className="ml-auto font-mono text-ember-300">{h.score.toFixed(3)}</span>
								</div>
								<p className="line-clamp-4 text-[13px] whitespace-pre-wrap text-ink-400">{h.text}</p>
							</div>
						))}
					</div>
				)}
			</section>

			<section>
				<h3 className="mb-3 font-mono text-[10.5px] tracking-widest text-ink-500 uppercase">{t("documents", { n: docs.length })}</h3>
				<div className="divide-y divide-ink-800 rounded-xl border border-ink-800">
					{docs.length === 0 && <p className="p-4 text-sm text-ink-500">{t("noDocs")}</p>}
					{docs.map((d) => (
						<div key={d.id} className="flex items-center gap-3 px-4 py-2.5">
							<FileText className="size-4 text-ink-500" />
							<span className="min-w-0 flex-1 truncate text-sm text-ink-200">{d.title}</span>
							<span className="font-mono text-[11px] text-ink-500">{t("chunks", { n: d.chunks })}</span>
							<Button
								variant="danger"
								onClick={async () => {
									const ok = await call((c) => c.rpc("kb.removeDocument", { id: base.id, documentId: d.id }));
									if (ok !== undefined) await Promise.all([loadDocs(), onChanged()]);
								}}
								aria-label={t("deleteDoc")}
							>
								<Trash2 className="size-3.5" />
							</Button>
						</div>
					))}
				</div>
			</section>
		</div>
	);
}
