#!/usr/bin/env python3
"""Page Feedback MCP — talks to one or more WordPress sites via Application Passwords.

Config: ~/.page-feedback/sites.json  (see sites.example.json)
Env override: PFB_SITES_FILE=/path/to/sites.json

This process never installs or activates the WordPress plugin.
"""

from __future__ import annotations

import base64
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

PROTOCOL = "2024-11-05"


def config_path() -> Path:
    env = os.environ.get("PFB_SITES_FILE")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".page-feedback" / "sites.json"


def load_sites() -> list[dict[str, str]]:
    path = config_path()
    if not path.is_file():
        return []
    data = json.loads(path.read_text())
    sites = data.get("sites", data if isinstance(data, list) else [])
    out = []
    for row in sites:
        if isinstance(row, dict) and row.get("id") and row.get("url"):
            out.append(row)
    return out


def site_by_id(site_id: str) -> dict[str, str]:
    for row in load_sites():
        if row["id"] == site_id:
            return row
    raise ValueError(f"Unknown site id: {site_id}. Known: {[s['id'] for s in load_sites()]}")


def rest_request(site: dict[str, str], method: str, path: str, body: dict | None = None) -> Any:
    base = site["url"].rstrip("/") + "/wp-json/pfb/v1/"
    url = base + path.lstrip("/")
    data = None
    headers = {"Accept": "application/json", "User-Agent": "page-feedback-mcp/0.1"}
    user = site.get("user") or ""
    password = (site.get("app_password") or "").replace(" ", "")
    if user and password:
        token = base64.b64encode(f"{user}:{password}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=45) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:800]
        raise RuntimeError(f"HTTP {exc.code} {url}: {detail}") from exc


def tool_result(text: str, extra: Any = None) -> dict:
    payload = extra if extra is not None else text
    return {
        "content": [{"type": "text", "text": text if extra is None else json.dumps(payload, indent=2)}],
    }


TOOLS = [
    {
        "name": "pfb_list_sites",
        "description": "List configured WordPress sites for Page Feedback (from ~/.page-feedback/sites.json).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "pfb_list_pages",
        "description": "List pages that have feedback notes on a site.",
        "inputSchema": {
            "type": "object",
            "properties": {"site": {"type": "string", "description": "Site id from pfb_list_sites"}},
            "required": ["site"],
        },
    },
    {
        "name": "pfb_list_notes",
        "description": "List notes. Filter by page slug and/or status (open, needs_info, done).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "site": {"type": "string"},
                "page": {"type": "string", "description": "Page slug, e.g. home"},
                "status": {"type": "string", "enum": ["open", "needs_info", "done"]},
            },
            "required": ["site"],
        },
    },
    {
        "name": "pfb_get_note",
        "description": "Get one note by WordPress id or widget entry id.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "site": {"type": "string"},
                "id": {"type": "string", "description": "wp_id or entry id"},
            },
            "required": ["site", "id"],
        },
    },
    {
        "name": "pfb_update_note",
        "description": "Update status, resolution, and/or question on a note.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "site": {"type": "string"},
                "id": {"type": "string"},
                "status": {"type": "string", "enum": ["open", "needs_info", "done"]},
                "resolution": {"type": "string"},
                "question": {"type": "string"},
            },
            "required": ["site", "id"],
        },
    },
    {
        "name": "pfb_mark_done",
        "description": "Mark a note done and store a short English resolution.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "site": {"type": "string"},
                "id": {"type": "string"},
                "resolution": {"type": "string"},
            },
            "required": ["site", "id", "resolution"],
        },
    },
    {
        "name": "pfb_ask_client",
        "description": "Set status to needs_info and ask the client a question on the note.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "site": {"type": "string"},
                "id": {"type": "string"},
                "question": {"type": "string"},
            },
            "required": ["site", "id", "question"],
        },
    },
]


def call_tool(name: str, args: dict[str, Any]) -> dict:
    if name == "pfb_list_sites":
        rows = [
            {"id": s["id"], "name": s.get("name") or s["id"], "url": s["url"]}
            for s in load_sites()
        ]
        return tool_result("", rows if rows else {"sites": [], "hint": f"Add sites in {config_path()}"})

    site = site_by_id(str(args.get("site") or ""))

    if name == "pfb_list_pages":
        return tool_result("", rest_request(site, "GET", "pages"))

    if name == "pfb_list_notes":
        qs = []
        if args.get("page"):
            qs.append("page=" + urllib.parse.quote(str(args["page"])))
        if args.get("status") and not args.get("page"):
            qs.append("status=" + urllib.parse.quote(str(args["status"])))
        path = "notes" + (("?" + "&".join(qs)) if qs else "")
        data = rest_request(site, "GET", path)
        if args.get("page") and args.get("status") and isinstance(data, list):
            data = [n for n in data if n.get("status") == args["status"]]
        return tool_result("", data)

    if name == "pfb_get_note":
        return tool_result("", rest_request(site, "GET", "notes/" + urllib.parse.quote(str(args["id"]))))

    if name == "pfb_update_note":
        body = {k: args[k] for k in ("status", "resolution", "question") if k in args and args[k] is not None}
        return tool_result("", rest_request(site, "POST", "notes/" + urllib.parse.quote(str(args["id"])), body))

    if name == "pfb_mark_done":
        return tool_result(
            "",
            rest_request(
                site,
                "POST",
                "notes/" + urllib.parse.quote(str(args["id"])),
                {"status": "done", "resolution": args.get("resolution") or ""},
            ),
        )

    if name == "pfb_ask_client":
        return tool_result(
            "",
            rest_request(
                site,
                "POST",
                "notes/" + urllib.parse.quote(str(args["id"])),
                {"status": "needs_info", "question": args.get("question") or ""},
            ),
        )

    raise ValueError(f"Unknown tool: {name}")


def read_message() -> dict | None:
    header = b""
    while not header.endswith(b"\r\n\r\n"):
        chunk = sys.stdin.buffer.read(1)
        if not chunk:
            return None
        header += chunk
    length = 0
    for line in header.decode("ascii", errors="replace").split("\r\n"):
        if line.lower().startswith("content-length:"):
            length = int(line.split(":", 1)[1].strip())
    if length <= 0:
        return None
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode("utf-8"))


def write_message(payload: dict) -> None:
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii") + raw)
    sys.stdout.buffer.flush()


def handle(msg: dict) -> dict | None:
    mid = msg.get("id")
    method = msg.get("method")
    params = msg.get("params") or {}

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": mid,
            "result": {
                "protocolVersion": PROTOCOL,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "page-feedback", "version": "0.1.0"},
            },
        }
    if method == "notifications/initialized":
        return None
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        try:
            result = call_tool(name, args)
            return {"jsonrpc": "2.0", "id": mid, "result": result}
        except Exception as exc:  # noqa: BLE001
            return {
                "jsonrpc": "2.0",
                "id": mid,
                "result": {
                    "content": [{"type": "text", "text": str(exc)}],
                    "isError": True,
                },
            }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if mid is None:
        return None
    return {
        "jsonrpc": "2.0",
        "id": mid,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main() -> None:
    while True:
        msg = read_message()
        if msg is None:
            return
        reply = handle(msg)
        if reply is not None:
            write_message(reply)


if __name__ == "__main__":
    main()
