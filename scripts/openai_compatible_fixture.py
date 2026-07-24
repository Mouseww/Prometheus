import json
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
            return
        self.send_error(404)

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        if self.headers.get("Authorization") != "Bearer fixture-secret":
            self.send_error(401)
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        assert body["model"] == "fixture-model"
        assert body["stream"] is True
        assert body["stream_options"] == {"include_usage": True}
        system_message = body["messages"][0]
        assert system_message["role"] == "system"
        assert system_message["content"] in {
            "Answer with verifiable evidence.",
            "Act as the research specialist.",
            "Act as the review specialist.",
            "Act as the autonomous coordinator.",
            "Act as the communicating research specialist.",
            "Act as the communicating review specialist.",
            "Act as the worktree implementation specialist.",
        }
        last_message = body["messages"][-1]
        system_prompt = system_message["content"]
        if (
            system_prompt == "Act as the autonomous coordinator."
            and last_message.get("content") == "Autonomously verify team communication."
        ):
            tool_names = [tool["function"]["name"] for tool in body.get("tools", [])]
            assert tool_names == [
                "list_directory", "read_file", "search_text", "write_file", "shell_command",
                "delegate_team",
            ]
            delegate = next(tool for tool in body["tools"] if tool["function"]["name"] == "delegate_team")
            agent_ids = delegate["function"]["parameters"]["properties"]["agentIds"]["items"]["enum"]
            assert len(agent_ids) == 2
            assert all(re.fullmatch(r"[0-9a-f-]{36}", agent_id) for agent_id in agent_ids)
            response = {
                "id": "fixture-autonomous-delegate",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "fixture-delegate-team",
                            "type": "function",
                            "function": {
                                "name": "delegate_team",
                                "arguments": json.dumps({
                                    "goal": "Verify autonomous delegation and durable Agent communication",
                                    "agentIds": agent_ids,
                                    "maxConcurrency": 2,
                                }),
                            },
                        }],
                    },
                    "finish_reason": "tool_calls",
                }],
                "usage": {"prompt_tokens": 18, "completion_tokens": 8, "total_tokens": 26},
            }
        elif (
            system_prompt == "Act as the autonomous coordinator."
            and last_message.get("role") == "tool"
        ):
            assert last_message["tool_call_id"] == "fixture-delegate-team"
            assert "Research agent shared durable evidence." in last_message["content"]
            assert "Review agent consumed the shared message." in last_message["content"]
            assert "Autonomous evidence" in last_message["content"]
            response = {
                "id": "fixture-autonomous-final",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "Coordinator verified autonomous delegation and durable Agent communication.",
                    },
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 28, "completion_tokens": 10, "total_tokens": 38},
            }
        elif (
            system_prompt == "Act as the communicating research specialist."
            and last_message.get("content", "").startswith(
                "Team goal: Verify autonomous delegation and durable Agent communication"
            )
        ):
            tool_names = [tool["function"]["name"] for tool in body.get("tools", [])]
            assert tool_names == [
                "list_directory", "read_file", "search_text",
                "send_team_message", "read_team_messages",
            ]
            response = {
                "id": "fixture-research-message",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "fixture-send-team-message",
                            "type": "function",
                            "function": {
                                "name": "send_team_message",
                                "arguments": json.dumps({
                                    "to": "*",
                                    "channel": "decision",
                                    "subject": "Autonomous evidence",
                                    "message": "Research agent shared durable evidence.",
                                }),
                            },
                        }],
                    },
                    "finish_reason": "tool_calls",
                }],
                "usage": {"prompt_tokens": 18, "completion_tokens": 8, "total_tokens": 26},
            }
        elif (
            system_prompt == "Act as the communicating research specialist."
            and last_message.get("role") == "tool"
        ):
            assert last_message["tool_call_id"] == "fixture-send-team-message"
            assert "Message sent to All agents" in last_message["content"]
            response = {
                "id": "fixture-research-final",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "Research agent shared durable evidence."},
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 22, "completion_tokens": 7, "total_tokens": 29},
            }
        elif (
            system_prompt == "Act as the communicating review specialist."
            and last_message.get("content", "").startswith(
                "Team goal: Verify autonomous delegation and durable Agent communication"
            )
        ):
            tool_names = [tool["function"]["name"] for tool in body.get("tools", [])]
            assert tool_names[-2:] == ["send_team_message", "read_team_messages"]
            response = {
                "id": "fixture-review-read",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "fixture-read-team-messages",
                            "type": "function",
                            "function": {
                                "name": "read_team_messages",
                                "arguments": json.dumps({"afterSequence": 0, "waitMs": 3000}),
                            },
                        }],
                    },
                    "finish_reason": "tool_calls",
                }],
                "usage": {"prompt_tokens": 18, "completion_tokens": 7, "total_tokens": 25},
            }
        elif (
            system_prompt == "Act as the communicating review specialist."
            and last_message.get("role") == "tool"
        ):
            assert last_message["tool_call_id"] == "fixture-read-team-messages"
            assert "Research agent shared durable evidence." in last_message["content"]
            response = {
                "id": "fixture-review-final",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "Review agent consumed the shared message."},
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 24, "completion_tokens": 8, "total_tokens": 32},
            }
        elif (
            system_prompt == "Act as the worktree implementation specialist."
            and last_message.get("content", "").startswith((
                "Team goal: Verify manual team worktree apply",
                "Team goal: Verify manual team worktree conflict",
            ))
        ):
            tool_names = [tool["function"]["name"] for tool in body.get("tools", [])]
            assert tool_names == [
                "list_directory", "read_file", "search_text", "write_file", "shell_command",
                "send_team_message", "read_team_messages",
            ]
            conflict = last_message["content"].startswith(
                "Team goal: Verify manual team worktree conflict"
            )
            path = "src/shared.txt" if conflict else "src/team-note.txt"
            content = "agent isolated version\n" if conflict else "Prometheus team worktree apply verified.\n"
            call_id = "fixture-worktree-conflict" if conflict else "fixture-worktree-apply"
            response = {
                "id": f"{call_id}-request",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": "write_file",
                                "arguments": json.dumps({"path": path, "content": content}),
                            },
                        }],
                    },
                    "finish_reason": "tool_calls",
                }],
                "usage": {"prompt_tokens": 18, "completion_tokens": 8, "total_tokens": 26},
            }
        elif last_message.get("content", "").startswith(
            "Team goal: Verify parallel team runtime"
        ):
            if system_message["content"] == "Act as the research specialist.":
                final_content = "Research subagent completed with independent evidence."
                response_id = "fixture-team-research"
            else:
                assert system_message["content"] == "Act as the review specialist."
                final_content = "Review subagent completed with independent evidence."
                response_id = "fixture-team-review"
            response = {
                "id": response_id,
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": final_content},
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 16, "completion_tokens": 8, "total_tokens": 24},
            }
        elif last_message.get("content") == "Inspect the repository with tools.":
            tool_names = [tool["function"]["name"] for tool in body.get("tools", [])]
            assert tool_names == ["list_directory", "read_file", "search_text", "write_file", "shell_command"]
            response = {
                "id": "fixture-tool-request",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "fixture-read-1",
                            "type": "function",
                            "function": {
                                "name": "read_file",
                                "arguments": json.dumps({"path": "README.md"}),
                            },
                        }],
                    },
                    "finish_reason": "tool_calls",
                }],
                "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
            }
        elif last_message.get("content") in {
            "Create an approved workspace note.",
            "Attempt a denied workspace note.",
        }:
            approved = last_message["content"].startswith("Create")
            path = "approved-note.txt" if approved else "denied-note.txt"
            call_id = "fixture-write-approved" if approved else "fixture-write-denied"
            tool_names = [tool["function"]["name"] for tool in body.get("tools", [])]
            assert tool_names == ["list_directory", "read_file", "search_text", "write_file", "shell_command"]
            response = {
                "id": f"{call_id}-request",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": "write_file",
                                "arguments": json.dumps({
                                    "path": path,
                                    "content": "Prometheus approval runtime verified.\n",
                                }),
                            },
                        }],
                    },
                    "finish_reason": "tool_calls",
                }],
                "usage": {"prompt_tokens": 12, "completion_tokens": 6, "total_tokens": 18},
            }
        elif last_message.get("content") == "Execute an approved shell command.":
            tool_names = [tool["function"]["name"] for tool in body.get("tools", [])]
            assert tool_names == ["list_directory", "read_file", "search_text", "write_file", "shell_command"]
            command = (
                "node -e \"require('node:fs').writeFileSync('shell-note.txt',"
                "'Prometheus shell runtime verified.','utf8');process.stdout.write('shell-proof')\""
            )
            response = {
                "id": "fixture-shell-request",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "fixture-shell-approved",
                            "type": "function",
                            "function": {
                                "name": "shell_command",
                                "arguments": json.dumps({
                                    "command": command,
                                    "workdir": "",
                                    "timeout_ms": 10_000,
                                }),
                            },
                        }],
                    },
                    "finish_reason": "tool_calls",
                }],
                "usage": {"prompt_tokens": 12, "completion_tokens": 6, "total_tokens": 18},
            }
        elif last_message.get("content") in {
            "Execute a permission-allowed shell command.",
            "Attempt a permission-denied shell command.",
        }:
            allowed = last_message["content"].startswith("Execute")
            tool_names = [tool["function"]["name"] for tool in body.get("tools", [])]
            assert tool_names == ["list_directory", "read_file", "search_text", "write_file", "shell_command"]
            filename = "allowed-rule.txt" if allowed else "blocked-rule.txt"
            marker = "allowed-rule" if allowed else "blocked-rule"
            command = (
                f"node -e \"require('node:fs').writeFileSync('{filename}',"
                f"'Prometheus permission policy verified.','utf8');process.stdout.write('{marker}')\""
            )
            response = {
                "id": "fixture-permission-rule-request",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "fixture-rule-allowed" if allowed else "fixture-rule-denied",
                            "type": "function",
                            "function": {
                                "name": "shell_command",
                                "arguments": json.dumps({
                                    "command": command,
                                    "workdir": "",
                                    "timeout_ms": 10_000,
                                }),
                            },
                        }],
                    },
                    "finish_reason": "tool_calls",
                }],
                "usage": {"prompt_tokens": 12, "completion_tokens": 6, "total_tokens": 18},
            }
        elif (
            system_prompt == "Act as the worktree implementation specialist."
            and last_message.get("role") == "tool"
        ):
            call_id = last_message["tool_call_id"]
            assert call_id in {"fixture-worktree-apply", "fixture-worktree-conflict"}
            path = "src/shared.txt" if call_id == "fixture-worktree-conflict" else "src/team-note.txt"
            assert last_message["content"].startswith("Wrote ")
            assert last_message["content"].endswith(f" bytes to {path}")
            response = {
                "id": f"{call_id}-final",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "Isolated worktree write completed with assigned-path evidence.",
                    },
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 24, "completion_tokens": 9, "total_tokens": 33},
            }
        elif last_message.get("role") == "tool":
            call_id = last_message["tool_call_id"]
            tool_name = body["messages"][-2]["tool_calls"][0]["function"]["name"]
            if call_id == "fixture-read-1":
                assert "# Prometheus" in last_message["content"]
                assert tool_name == "read_file"
                final_content = "Workspace evidence: README identifies the project as Prometheus."
            elif call_id == "fixture-shell-approved":
                assert "Exit code: 0" in last_message["content"]
                assert "shell-proof" in last_message["content"]
                assert tool_name == "shell_command"
                final_content = "Approved shell command completed."
            elif call_id == "fixture-rule-allowed":
                assert "Exit code: 0" in last_message["content"]
                assert "allowed-rule" in last_message["content"]
                assert tool_name == "shell_command"
                final_content = "Permission rule allowed shell command."
            elif call_id == "fixture-rule-denied":
                assert last_message["content"] == "Tool execution denied by permission rule"
                assert tool_name == "shell_command"
                final_content = "Permission rule denied shell command."
            elif call_id == "fixture-write-approved":
                assert last_message["content"] == "Wrote 38 bytes to approved-note.txt"
                assert tool_name == "write_file"
                final_content = "Approved write completed."
            else:
                assert call_id == "fixture-write-denied"
                assert last_message["content"] == "Tool execution denied by user"
                assert tool_name == "write_file"
                final_content = "Denied write was not executed."
            response = {
                "id": "fixture-tool-final",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": final_content,
                    },
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30},
            }
        elif last_message.get("content") == "Stream a verified response.":
            response = {
                "id": "fixture-streaming-response",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "Streaming fixture reply arrived on both terminals."}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 9, "total_tokens": 19},
            }
        else:
            assert last_message["content"] == "Verify the complete runtime path."
            response = {
                "id": "fixture-response-1",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture-model",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "Fixture provider reply: end-to-end runtime works."}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18},
            }
        self._send_stream(response)

    def _send_stream(self, response):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        choice = response["choices"][0]
        message = choice["message"]
        tool_calls = message.get("tool_calls") or []
        if tool_calls:
            self._send_tool_call_chunks(response, choice, tool_calls[0])
        else:
            self._send_text_chunks(response, choice, message.get("content") or "")

        self._send_event({
            "id": response["id"],
            "object": "chat.completion.chunk",
            "created": response["created"],
            "model": response["model"],
            "choices": [],
            "usage": response["usage"],
        })
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _send_text_chunks(self, response, choice, content):
        first = max(1, len(content) // 3)
        second = max(first + 1, (len(content) * 2) // 3)
        parts = (content[:first], content[first:second], content[second:])
        assert all(parts)
        for index, part in enumerate(parts):
            self._send_event(self._chunk(
                response,
                {"content": part},
                choice["finish_reason"] if index == len(parts) - 1 else None,
            ))
            if index < len(parts) - 1:
                time.sleep(0.2)

    def _send_tool_call_chunks(self, response, choice, tool_call):
        arguments = tool_call["function"]["arguments"]
        split_at = max(1, len(arguments) // 2)
        parts = (arguments[:split_at], arguments[split_at:])
        assert all(parts)
        self._send_event(self._chunk(response, {
            "tool_calls": [{
                "index": 0,
                "id": tool_call["id"],
                "type": "function",
                "function": {
                    "name": tool_call["function"]["name"],
                    "arguments": parts[0],
                },
            }],
        }, None))
        self._send_event(self._chunk(response, {
            "tool_calls": [{
                "index": 0,
                "function": {"arguments": parts[1]},
            }],
        }, choice["finish_reason"]))

    def _chunk(self, response, delta, finish_reason):
        return {
            "id": response["id"],
            "object": "chat.completion.chunk",
            "created": response["created"],
            "model": response["model"],
            "choices": [{
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason,
            }],
        }

    def _send_event(self, payload):
        encoded = json.dumps(payload, separators=(",", ":")).encode()
        self.wfile.write(b"data: " + encoded + b"\n\n")
        self.wfile.flush()

    def log_message(self, *_args):
        return


ThreadingHTTPServer(("127.0.0.1", 4320), Handler).serve_forever()
