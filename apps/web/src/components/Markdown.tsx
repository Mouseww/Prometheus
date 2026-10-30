import { Check, Copy } from "lucide-react";
import { isValidElement, memo, useState, type ReactNode } from "react";
import { copyToClipboard } from "../lib/clipboard.ts";
import { toast } from "../lib/store.ts";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { looksLikeFilePath } from "../lib/download.ts";
import { PathCode } from "./FileDownloadButton.tsx";

function textOf(node: ReactNode): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
	return "";
}

function CodeBlock({ children, ...rest }: React.ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
	const [done, setDone] = useState(false);
	const { node: _node, ...pre } = rest;
	const copy = async () => {
		try {
			await copyToClipboard(textOf(children).replace(/\n$/, ""));
			setDone(true);
			setTimeout(() => setDone(false), 1500);
		} catch (err) {
			toast(err instanceof Error ? err.message : String(err), "error");
		}
	};
	return (
		<div className="group/code relative">
			<button type="button" onClick={() => void copy()} title="Copy" aria-label="Copy" className="absolute top-2 right-2 z-10 grid size-7 place-items-center rounded-md bg-ink-800/80 text-ink-300 hover:text-ink-100">
				{done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
			</button>
			<pre {...pre}>{children}</pre>
		</div>
	);
}

/** Inline code naming a file gets a download button once the server confirms the file is there; blocks and other code stay as they are. */
const components = {
	pre: CodeBlock,
	code({ className, children, node: _node, ...rest }: React.ComponentPropsWithoutRef<"code"> & { node?: unknown }) {
		const text = typeof children === "string" ? children : "";
		if (!className && text && !/[\r\n]/.test(text) && looksLikeFilePath(text)) return <PathCode path={text}>{children}</PathCode>;
		return (
			<code className={className} {...rest}>
				{children}
			</code>
		);
	},
};

// Unlabeled code blocks get their language detected, so every code block is coloured.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="prose-forge">
			<ReactMarkdown components={components} remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}>
				{text}
			</ReactMarkdown>
		</div>
	);
});
