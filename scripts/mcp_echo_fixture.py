#!/usr/bin/env python3
"""Minimal MCP stdio server fixture: tools/list + tools/call echo."""
import json
import sys


def read_message():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        key, _, value = line.decode("utf-8").partition(":")
        headers[key.strip().lower()] = value.strip()
    length = int(headers.get("content-length", "0"))
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode("utf-8"))


def write_message(payload):
    raw = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii"))
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()


def main():
    while True:
        message = read_message()
        if message is None:
            return
        method = message.get("method")
        msg_id = message.get("id")
        if method == "initialize":
            write_message({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "echo-fixture", "version": "0.1.0"},
                },
            })
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            write_message({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "tools": [{
                        "name": "echo",
                        "description": "Echo a message",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "message": {"type": "string"}
                            },
                            "required": ["message"],
                        },
                    }]
                },
            })
        elif method == "tools/call":
            args = (message.get("params") or {}).get("arguments") or {}
            text = args.get("message", "")
            write_message({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": f"echo:{text}"}],
                    "isError": False,
                },
            })
        elif msg_id is not None:
            write_message({
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"},
            })


if __name__ == "__main__":
    main()
