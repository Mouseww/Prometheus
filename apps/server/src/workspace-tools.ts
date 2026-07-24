import type { AgentTool } from "@prometheus/agent-core";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { WorkspaceService } from "./workspace-service.js";

const readFileInputSchema = z.object({
  path: z.string().trim().min(1).max(2_048),
});
const listDirectoryInputSchema = z.object({
  path: z.string().trim().max(2_048).default(""),
});
const searchTextInputSchema = z.object({
  query: z.string().min(1).max(500),
  path: z.string().trim().max(2_048).default(""),
});
const writeFileInputSchema = z.object({
  path: z.string().trim().min(1).max(2_048),
  content: z.string().max(1024 * 1024),
});

export class WorkspaceToolRegistry {
  constructor(private readonly workspace: WorkspaceService) {}

  readonly(): AgentTool[] {
    return [
      this.listDirectoryTool(),
      this.readFileTool(),
      this.searchTextTool(),
    ];
  }

  list(): AgentTool[] {
    return [
      ...this.readonly(),
      this.writeFileTool(),
    ];
  }

  private listDirectoryTool(): AgentTool {
    return {
      approval: "never",
      definition: {
        name: "list_directory",
        description: "List files and directories at a workspace-relative path.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative directory path; empty means root" },
          },
          additionalProperties: false,
        },
      },
      execute: async (argumentsValue) => {
        const input = listDirectoryInputSchema.parse(argumentsValue);
        const nodes = this.workspace.list(input.path);
        return {
          content: nodes.length > 0
            ? nodes.map((node) => `${node.kind}\t${node.path}`).join("\n")
            : "[Directory is empty]",
          isError: false,
        };
      },
    };
  }

  private readFileTool(): AgentTool {
    return {
      approval: "never",
      definition: {
        name: "read_file",
        description: "Read a UTF-8 text file inside the workspace.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      execute: async (argumentsValue) => {
        const input = readFileInputSchema.parse(argumentsValue);
        const result = this.workspace.readTextFile(input.path);
        return {
          content: result.truncated
            ? `${result.content}\n\n[Output truncated at 65536 bytes]`
            : result.content,
          isError: false,
        };
      },
    };
  }

  private searchTextTool(): AgentTool {
    return {
      approval: "never",
      definition: {
        name: "search_text",
        description: "Search UTF-8 workspace files recursively for literal text.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Literal text to find" },
            path: { type: "string", description: "Workspace-relative file or directory; empty means root" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      execute: async (argumentsValue) => {
        const input = searchTextInputSchema.parse(argumentsValue);
        const matches = this.workspace.searchText(input.query, input.path);
        return {
          content: matches.length > 0
            ? matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n")
            : "[No matches]",
          isError: false,
        };
      },
    };
  }

  private writeFileTool(): AgentTool {
    return {
      approval: "always",
      definition: {
        name: "write_file",
        description: "Write UTF-8 text to a workspace-relative file after user approval.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path" },
            content: { type: "string", description: "Complete UTF-8 file content" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      summarizeArguments: (argumentsValue) => {
        const path = typeof argumentsValue.path === "string" ? argumentsValue.path : "[invalid path]";
        const content = typeof argumentsValue.content === "string" ? argumentsValue.content : "";
        const characters = Array.from(content);
        const previewLength = Math.min(200, Math.max(0, characters.length - 1));
        return {
          path,
          contentBytes: Buffer.byteLength(content, "utf8"),
          contentPreview: characters.slice(0, previewLength).join(""),
          contentPreviewTruncated: previewLength < characters.length,
          contentSha256: createHash("sha256").update(content, "utf8").digest("hex"),
        };
      },
      permissionTarget: (argumentsValue) => writeFileInputSchema.parse(argumentsValue).path,
      execute: async (argumentsValue) => {
        const input = writeFileInputSchema.parse(argumentsValue);
        const result = this.workspace.writeTextFile(input.path, input.content);
        return {
          content: `Wrote ${result.bytes} bytes to ${result.path}`,
          isError: false,
        };
      },
    };
  }
}
