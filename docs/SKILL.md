---
name: page-feedback
description: >-
  Fetch, fix, and resolve client Page Feedback notes on any WordPress site
  via the page-feedback MCP. Use when the user says check feedback, fix
  feedback, page feedback, PFB notes, open notes, or mark feedback done.
---

# Page Feedback

Client click-to-comment notes live in the **Page Feedback** WordPress plugin (`pfb/v1` REST). Do not use the old MTB theme JSON workflow.

The plugin is **off by default** and may not be installed on the current site. Do not activate or upload it unless the user asks.

## Workflow

1. Read this skill, then use MCP tools prefixed `pfb_`.
2. `pfb_list_sites` — if empty, tell the user to copy `mcp/sites.example.json` to `~/.page-feedback/sites.json`.
3. Ask which site if more than one, unless the user already named it.
4. `pfb_list_notes` with `status=open` (and `needs_info` if useful).
5. For each note: read `note`, `selector`, `url`, `page`, `images` / `files`.
6. Fix only that request. Keep unrelated client edits.
7. `pfb_mark_done` with a short **English** resolution.
8. If the note is unclear: `pfb_ask_client` (status becomes `needs_info`). Do not guess.

## Rules

- Chat with the user in Vietnamese; resolutions and UI copy in English.
- Never enable the widget on a live site unless asked.
- Never commit Application Passwords.
- Same merge discipline as WP page content: fetch latest, change only what the note asked.

## Tool map

| Tool | When |
|------|------|
| `pfb_list_sites` | Start |
| `pfb_list_pages` | See which slugs have notes |
| `pfb_list_notes` | Inbox |
| `pfb_get_note` | Full note + attachments |
| `pfb_mark_done` | After a real fix |
| `pfb_ask_client` | Need a client reply |
| `pfb_update_note` | Reopen or edit fields |
