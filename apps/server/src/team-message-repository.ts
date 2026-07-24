import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  teamMessageChannelSchema,
  teamMessageRecipientSchema,
  teamMessageSchema,
  type TeamMessage,
  type TeamMessageChannel,
  type TeamMessageRecipient,
} from "@prometheus/protocol";

interface TeamMessageRow {
  sequence: number;
  id: string;
  team_run_id: string;
  session_id: string;
  sender_agent_id: string;
  sender_label: string;
  recipient_id: string;
  recipient_label: string;
  channel: string;
  subject: string | null;
  body: string;
  source_run_id: string | null;
  source_tool_call_id: string | null;
  created_at: string;
}

interface TeamMemberRow {
  agent_id: string;
  agent_label: string;
  session_id: string;
}

export interface AppendTeamMessageInput {
  teamRunId: string;
  senderAgentId: string;
  recipientId: TeamMessageRecipient;
  channel: TeamMessageChannel;
  subject?: string | null;
  body: string;
  sourceRunId?: string | null;
  sourceToolCallId?: string | null;
}

export class TeamMessageRepository {
  constructor(private readonly database: DatabaseSync) {}

  append(rawInput: AppendTeamMessageInput): TeamMessage {
    const recipientId = teamMessageRecipientSchema.parse(rawInput.recipientId);
    const channel = teamMessageChannelSchema.parse(rawInput.channel);
    const body = rawInput.body.trim();
    if (!body || body.length > 12_000) throw new TeamMessageRepositoryError("Message body is invalid");
    const subject = rawInput.subject?.trim() || null;
    if (subject && subject.length > 160) throw new TeamMessageRepositoryError("Message subject is too long");

    const members = this.#members(rawInput.teamRunId);
    if (members.length === 0) throw new TeamMessageRepositoryError("Team run not found");
    const sender = members.find((member) => member.agent_id === rawInput.senderAgentId);
    if (!sender) throw new TeamMessageRepositoryError("Message sender is not a member of this team");
    const recipient = recipientId === "parent" || recipientId === "*"
      ? null
      : members.find((member) => member.agent_id === recipientId);
    if (recipientId !== "parent" && recipientId !== "*" && !recipient) {
      throw new TeamMessageRepositoryError("Message recipient is not a member of this team");
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO team_messages (
        id, team_run_id, session_id, sender_agent_id, sender_label,
        recipient_id, recipient_label, channel, subject, body,
        source_run_id, source_tool_call_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      rawInput.teamRunId,
      sender.session_id,
      sender.agent_id,
      sender.agent_label,
      recipientId,
      recipientId === "parent" ? "Parent agent" : recipientId === "*" ? "All agents" : recipient!.agent_label,
      channel,
      subject,
      body,
      rawInput.sourceRunId ?? null,
      rawInput.sourceToolCallId ?? null,
      createdAt,
    );
    return this.#get(id)!;
  }

  list(teamRunId: string, afterSequence = 0): TeamMessage[] {
    return (this.database.prepare(`
      SELECT * FROM team_messages
      WHERE team_run_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT 200
    `).all(teamRunId, afterSequence) as unknown as TeamMessageRow[]).map(mapMessage);
  }

  listVisibleTo(teamRunId: string, agentId: string, afterSequence = 0): TeamMessage[] {
    return (this.database.prepare(`
      SELECT * FROM team_messages
      WHERE team_run_id = ? AND sequence > ?
        AND (recipient_id = '*' OR recipient_id = ? OR sender_agent_id = ?)
      ORDER BY sequence ASC
      LIMIT 200
    `).all(teamRunId, afterSequence, agentId, agentId) as unknown as TeamMessageRow[]).map(mapMessage);
  }

  #get(id: string): TeamMessage | undefined {
    const row = this.database.prepare("SELECT * FROM team_messages WHERE id = ?")
      .get(id) as unknown as TeamMessageRow | undefined;
    return row ? mapMessage(row) : undefined;
  }

  #members(teamRunId: string): TeamMemberRow[] {
    return this.database.prepare(`
      SELECT agent_id, agent_label, session_id
      FROM team_run_tasks
      WHERE team_run_id = ?
      ORDER BY ordinal ASC
    `).all(teamRunId) as unknown as TeamMemberRow[];
  }
}

export class TeamMessageRepositoryError extends Error {}

function mapMessage(row: TeamMessageRow): TeamMessage {
  return teamMessageSchema.parse({
    id: row.id,
    sequence: row.sequence,
    teamRunId: row.team_run_id,
    sessionId: row.session_id,
    senderAgentId: row.sender_agent_id,
    senderLabel: row.sender_label,
    recipientId: row.recipient_id,
    recipientLabel: row.recipient_label,
    channel: row.channel,
    subject: row.subject,
    body: row.body,
    sourceRunId: row.source_run_id,
    sourceToolCallId: row.source_tool_call_id,
    createdAt: row.created_at,
  });
}
