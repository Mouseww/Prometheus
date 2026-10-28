import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { looksLikeFilePath } from "../lib/download.ts";
import { PathCode } from "./FileDownloadButton.tsx";

/** Inline code naming a file gets a download button once the server confirms the file is there; blocks and other code stay as they are. */
const components = {
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
