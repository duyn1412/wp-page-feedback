# Page Feedback

Portable WordPress plugin + MCP for the old MTB click-to-comment workflow.

**Not installed or activated on any live/staging site.** This folder is a standalone kit.

## What it is

Same client flow as before:

1. Logged-in editor opens the site (or `?pfb=1` if that override is on).
2. Clicks **Feedback**, then an element (or General feedback).
3. Leaves a note + images / DOC / PDF.
4. **Save feedback** writes notes to WordPress (private CPT + Media Library).
5. Agent pulls open notes over MCP, fixes the site, marks **done** or **needs_info**.

Status values: `open` | `needs_info` | `done`.

## Layout

```
plugin/page-feedback/   WordPress plugin (zip or copy into wp-content/plugins/)
mcp/server.py           Local MCP Server (Python: Application Password → REST)
mcp/sites.example.json  Copy to ~/.page-feedback/sites.json
standalone/             Zero-WP mode (widget.js + save.php for any HTML/PHP site)
docs/                   MCP & Skill configuration examples
```

Widget is **off by default**. After you install the plugin on a site later, turn it on under **Page Feedback → Settings**, or define `PFB_ENABLED` in wp-config.

## Install later (when you choose a site)

1. Copy `plugin/page-feedback/` into that site’s `wp-content/plugins/`.
2. Activate **Page Feedback** in wp-admin. Do not enable the widget yet unless you want clients to see it.
3. Create an Application Password for an editor.
4. Add the site to `~/.page-feedback/sites.json`.
5. Point Cursor at the MCP (example in `docs/cursor-mcp.example.json`).

## REST (`/wp-json/pfb/v1/`)

Requires a user who can `edit_posts` (cookie nonce or Application Password).

| Method | Path | Use |
|--------|------|-----|
| GET | `/pages` | Slugs + counts |
| GET | `/notes?status=open` | Agent inbox |
| GET | `/notes?page=home` | Widget list (raw array) |
| GET | `/notes/{id}` | One note (`wp_id` or entry id) |
| POST | `/notes/{id}` | `{ status, resolution, question }` |
| POST | `/sync` | Widget save / delete |

## MCP tools

`pfb_list_sites` · `pfb_list_pages` · `pfb_list_notes` · `pfb_get_note` · `pfb_update_note` · `pfb_mark_done` · `pfb_ask_client`

## Differences from the old MTB theme code

- Not tied to the `mtb` theme or `themes/mtb/feedback/*.json`.
- Notes live in CPT `pfb_note` (private) so any theme works.
- Attachments go to the Media Library.
- One MCP config can list every client site.
