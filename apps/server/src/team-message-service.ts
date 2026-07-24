import { randomUUID } from "node:crypto";
import type { TeamMessage } from "@prometheus/protocol";
import type { EventHub } from "./event-hub.js";
import type { SessionRepository } from "./session-repository.js";
import {
  TeamMessageRepositoryError,
  type AppendTeamMessageInput,
  type TeamMessageRepository,
} from "./team-message-repository.js";

export class TeamMessageService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly messages: TeamMessageRepository,
    private readonly eventHub: EventHub,
  ) {}

  send(input: AppendTeamMessageInput): TeamMessage {
    try {
      const message = this.messages.append(input);
      const event = this.sessions.appendEvent(message.sessionId, {
        eventId: randomUUID(),
        type: "agent.message",
        actor: { kind: "agent", id: message.senderAgentId, label: message.senderLabel },
        payload: {
          teamRunId: message.teamRunId,
          messageId: message.id,
          messageSequence: message.sequence,
          recipientId: message.recipientId,
          recipientLabel: message.recipientLabel,
          channel: message.channel,
          subject: message.subject,
          text: message.body,
          sourceRunId: message.sourceRunId,
          sourceToolCallId: message.sourceToolCallId,
        },
      });
      this.eventHub.publish(event);
      return message;
    } catch (error) {
      if (error instanceof TeamMessageRepositoryError) {
        throw new TeamMessageValidationError(error.message);
      }
      throw error;
    }
  }
}

export class TeamMessageValidationError extends Error {}
