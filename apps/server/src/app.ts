import cors from "@fastify/cors";
import staticFiles from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  createAgentProfileSchema,
  createAgentRunSchema,
  createProviderSchema,
  createPermissionRuleSchema,
  appendEventSchema,
  createSessionSchema,
  createTeamRunSchema,
  resolveApprovalSchema,
  updateAgentProfileSchema,
  updateProviderSchema,
  type WebSocketEnvelope,
} from "@prometheus/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { AgentRepository } from "./agent-repository.js";
import { AgentRunExecutionError, AgentRunValidationError, type AgentRunService } from "./agent-run-service.js";
import {
  ApprovalConflictError,
  type ApprovalCoordinator,
  ApprovalNotFoundError,
} from "./approval-coordinator.js";
import { EventHub } from "./event-hub.js";
import type { ProviderRepository } from "./provider-repository.js";
import type { PermissionRuleRepository } from "./permission-rule-repository.js";
import {
  EventConflictError,
  SessionNotFoundError,
  SessionRepository,
} from "./session-repository.js";
import { WorkspaceBoundaryError, WorkspaceService } from "./workspace-service.js";
import { RunStreamHub } from "./run-stream-hub.js";
import type { TeamRunRepository } from "./team-run-repository.js";
import {
  TeamRunConflictError,
  TeamRunTaskNotFoundError,
  TeamRunValidationError,
  type TeamRunService,
} from "./team-run-service.js";
import type { TeamMessageRepository } from "./team-message-repository.js";

const sessionParamsSchema = z.object({ sessionId: z.uuid() });
const approvalParamsSchema = z.object({ sessionId: z.uuid(), approvalId: z.uuid() });
const providerParamsSchema = z.object({ providerId: z.uuid() });
const agentParamsSchema = z.object({ agentId: z.uuid() });
const permissionRuleParamsSchema = z.object({ ruleId: z.uuid() });
const teamRunParamsSchema = z.object({ teamRunId: z.uuid() });
const teamTaskParamsSchema = z.object({ teamRunId: z.uuid(), teamTaskId: z.uuid() });
const teamMessageQuerySchema = z.object({
  afterSequence: z.coerce.number().int().nonnegative().default(0),
});
const eventQuerySchema = z.object({
  afterSequence: z.coerce.number().int().nonnegative().default(0),
});
const workspaceQuerySchema = z.object({
  path: z.string().max(2048).default(""),
});
const socketQuerySchema = z.object({
  sessionId: z.uuid(),
  afterSequence: z.coerce.number().int().nonnegative().default(0),
});

export interface AppDependencies {
  repository: SessionRepository;
  workspace: WorkspaceService;
  eventHub?: EventHub;
  webRoot?: string;
  providers?: ProviderRepository;
  agents?: AgentRepository;
  agentRuns?: AgentRunService;
  approvals?: ApprovalCoordinator;
  permissionRules?: PermissionRuleRepository;
  runStreams?: RunStreamHub;
  teams?: TeamRunRepository;
  teamRuns?: TeamRunService;
  teamMessages?: TeamMessageRepository;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const eventHub = dependencies.eventHub ?? new EventHub();
  const runStreams = dependencies.runStreams ?? new RunStreamHub();

  await app.register(cors, { origin: true });
  await app.register(websocket);
  const webRoot = dependencies.webRoot;
  if (webRoot && existsSync(webRoot)) {
    await app.register(staticFiles, {
      root: webRoot,
      wildcard: false,
    });
  }

  app.get("/api/health", async () => ({
    status: "ok",
    workspace: dependencies.workspace.rootName,
    timestamp: new Date().toISOString(),
  }));

  app.get("/api/workspace", async (request) => {
    const query = workspaceQuerySchema.parse(request.query);
    return {
      rootName: dependencies.workspace.rootName,
      path: query.path,
      nodes: dependencies.workspace.list(query.path),
    };
  });

  app.get("/api/sessions", async () => ({
    sessions: dependencies.repository.listSessions(),
  }));

  app.post("/api/sessions", async (request, reply) => {
    const input = createSessionSchema.parse(request.body);
    const session = dependencies.repository.createSession(input.title);
    return reply.code(201).send({ session });
  });

  app.get("/api/sessions/:sessionId/events", async (request) => {
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const { afterSequence } = eventQuerySchema.parse(request.query);
    assertSession(dependencies.repository, sessionId);
    return {
      events: dependencies.repository.listEvents(sessionId, afterSequence),
    };
  });

  app.post("/api/sessions/:sessionId/events", async (request, reply) => {
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const input = appendEventSchema.parse(request.body);
    const event = dependencies.repository.appendEvent(sessionId, input);
    eventHub.publish(event);
    return reply.code(201).send({ event });
  });

  if (dependencies.permissionRules) {
    app.get("/api/permission-rules", async () => ({
      rules: dependencies.permissionRules!.list(),
    }));
    app.post("/api/permission-rules", async (request, reply) => {
      const rule = dependencies.permissionRules!.create(createPermissionRuleSchema.parse(request.body));
      return reply.code(201).send({ rule });
    });
    app.delete("/api/permission-rules/:ruleId", async (request, reply) => {
      const { ruleId } = permissionRuleParamsSchema.parse(request.params);
      if (!dependencies.permissionRules!.delete(ruleId)) {
        return reply.code(404).send({
          error: "permission_rule_not_found",
          message: "Permission rule not found",
        });
      }
      return reply.code(204).send();
    });
  }

  if (dependencies.approvals) {
    app.post(
      "/api/sessions/:sessionId/approvals/:approvalId/resolution",
      async (request) => {
        const { sessionId, approvalId } = approvalParamsSchema.parse(request.params);
        assertSession(dependencies.repository, sessionId);
        const { decision } = resolveApprovalSchema.parse(request.body);
        return {
          approval: dependencies.approvals!.resolve(sessionId, approvalId, decision),
        };
      },
    );
  }

  if (dependencies.providers && dependencies.agents && dependencies.agentRuns) {
    app.get("/api/providers", async () => ({ providers: dependencies.providers!.list() }));
    app.post("/api/providers", async (request, reply) => {
      const provider = dependencies.providers!.create(createProviderSchema.parse(request.body));
      return reply.code(201).send({ provider });
    });
    app.patch("/api/providers/:providerId", async (request) => {
      const { providerId } = providerParamsSchema.parse(request.params);
      const provider = dependencies.providers!.update(providerId, updateProviderSchema.parse(request.body));
      if (!provider) throw new ConfigurationNotFoundError("Provider not found");
      return { provider };
    });

    app.get("/api/agents", async () => ({ agents: dependencies.agents!.list() }));
    app.post("/api/agents", async (request, reply) => {
      const input = createAgentProfileSchema.parse(request.body);
      if (!dependencies.providers!.get(input.providerId)) {
        throw new ConfigurationReferenceNotFoundError("Provider not found");
      }
      const agent = dependencies.agents!.create(input);
      return reply.code(201).send({ agent });
    });
    app.patch("/api/agents/:agentId", async (request) => {
      const { agentId } = agentParamsSchema.parse(request.params);
      const input = updateAgentProfileSchema.parse(request.body);
      if (input.providerId && !dependencies.providers!.get(input.providerId)) {
        throw new ConfigurationReferenceNotFoundError("Provider not found");
      }
      const agent = dependencies.agents!.update(agentId, input);
      if (!agent) throw new ConfigurationNotFoundError("Agent not found");
      return { agent };
    });

    app.post("/api/sessions/:sessionId/runs", async (request, reply) => {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const { agentId } = createAgentRunSchema.parse(request.body);
      const result = await dependencies.agentRuns!.run(sessionId, agentId);
      return reply.code(201).send({ run: result });
    });
  }

  if (dependencies.teams && dependencies.teamRuns) {
    app.get("/api/sessions/:sessionId/team-runs", async (request) => {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      assertSession(dependencies.repository, sessionId);
      return { teams: dependencies.teams!.listForSession(sessionId) };
    });
    app.post("/api/sessions/:sessionId/team-runs", async (request, reply) => {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const input = createTeamRunSchema.parse(request.body);
      const team = dependencies.teamRuns!.launch(sessionId, input);
      return reply.code(202).send({ team });
    });
    app.get("/api/team-runs/:teamRunId", async (request) => {
      const { teamRunId } = teamRunParamsSchema.parse(request.params);
      const team = dependencies.teams!.get(teamRunId);
      if (!team) throw new TeamRunNotFoundError("Team run not found");
      return { team };
    });
    app.post("/api/team-runs/:teamRunId/tasks/:teamTaskId/apply", async (request) => {
      const { teamRunId, teamTaskId } = teamTaskParamsSchema.parse(request.params);
      return { team: dependencies.teamRuns!.applyTaskChanges(teamRunId, teamTaskId) };
    });
    app.post("/api/team-runs/:teamRunId/tasks/:teamTaskId/discard", async (request) => {
      const { teamRunId, teamTaskId } = teamTaskParamsSchema.parse(request.params);
      return { team: dependencies.teamRuns!.discardTaskChanges(teamRunId, teamTaskId) };
    });
    if (dependencies.teamMessages) {
      app.get("/api/team-runs/:teamRunId/messages", async (request) => {
        const { teamRunId } = teamRunParamsSchema.parse(request.params);
        const { afterSequence } = teamMessageQuerySchema.parse(request.query);
        if (!dependencies.teams!.get(teamRunId)) {
          throw new TeamRunNotFoundError("Team run not found");
        }
        return { messages: dependencies.teamMessages!.list(teamRunId, afterSequence) };
      });
    }
  }

  app.get("/ws", { websocket: true }, (socket, request) => {
    const parsed = socketQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      const envelope: WebSocketEnvelope = {
        kind: "error",
        message: "Invalid session subscription",
      };
      socket.send(JSON.stringify(envelope));
      socket.close(1008, "Invalid subscription");
      return;
    }

    const { sessionId, afterSequence } = parsed.data;
    if (!dependencies.repository.getSession(sessionId)) {
      const envelope: WebSocketEnvelope = {
        kind: "error",
        message: "Session not found",
      };
      socket.send(JSON.stringify(envelope));
      socket.close(1008, "Session not found");
      return;
    }

    const syncEnvelope: WebSocketEnvelope = {
      kind: "sync",
      events: dependencies.repository.listEvents(sessionId, afterSequence),
    };
    socket.send(JSON.stringify(syncEnvelope));

    const unsubscribeEvents = eventHub.subscribe(sessionId, (event) => {
      if (socket.readyState !== socket.OPEN) {
        return;
      }
      const envelope: WebSocketEnvelope = { kind: "event", event };
      socket.send(JSON.stringify(envelope));
    });
    const unsubscribeStream = runStreams.subscribe(sessionId, (envelope) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(envelope));
    });
    for (const activeStream of runStreams.list(sessionId)) {
      const envelope: WebSocketEnvelope = { kind: "run.stream.snapshot", stream: activeStream };
      socket.send(JSON.stringify(envelope));
    }
    const unsubscribe = () => {
      unsubscribeEvents();
      unsubscribeStream();
    };
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });

  app.setNotFoundHandler((request, reply) => {
    if (webRoot && request.headers.accept?.includes("text/html")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found", message: "Route not found" });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: "invalid_request",
        message: error.issues.map((issue) => issue.message).join("; "),
      });
    }
    if (error instanceof SessionNotFoundError) {
      return reply.code(404).send({ error: "session_not_found", message: error.message });
    }
    if (error instanceof EventConflictError) {
      return reply.code(409).send({ error: "event_conflict", message: error.message });
    }
    if (error instanceof ApprovalNotFoundError) {
      return reply.code(404).send({ error: "approval_not_found", message: error.message });
    }
    if (error instanceof ApprovalConflictError) {
      return reply.code(409).send({ error: "approval_conflict", message: error.message });
    }
    if (error instanceof WorkspaceBoundaryError) {
      return reply.code(403).send({ error: "workspace_boundary", message: error.message });
    }
    if (error instanceof ConfigurationNotFoundError || error instanceof AgentRunValidationError) {
      return reply.code(404).send({ error: "configuration_not_found", message: error.message });
    }
    if (error instanceof ConfigurationReferenceNotFoundError) {
      return reply.code(422).send({
        error: "configuration_reference_not_found",
        message: error.message,
      });
    }
    if (error instanceof AgentRunExecutionError) {
      return reply.code(502).send({ error: "provider_request_failed", message: error.message });
    }
    if (error instanceof TeamRunNotFoundError) {
      return reply.code(404).send({ error: "team_run_not_found", message: error.message });
    }
    if (error instanceof TeamRunValidationError) {
      return reply.code(404).send({ error: "team_run_dependency_not_found", message: error.message });
    }
    if (error instanceof TeamRunTaskNotFoundError) {
      return reply.code(404).send({ error: "team_task_not_found", message: error.message });
    }
    if (error instanceof TeamRunConflictError) {
      return reply.code(409).send({ error: "team_task_conflict", message: error.message });
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return reply.code(404).send({ error: "path_not_found", message: "Path not found" });
    }

    app.log.error(error);
    return reply.code(500).send({ error: "internal_error", message: "Internal server error" });
  });

  return app;
}

class ConfigurationNotFoundError extends Error {}
class ConfigurationReferenceNotFoundError extends Error {}
class TeamRunNotFoundError extends Error {}

function assertSession(repository: SessionRepository, sessionId: string): void {
  if (!repository.getSession(sessionId)) {
    throw new SessionNotFoundError(sessionId);
  }
}
