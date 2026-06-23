# Scheduled Node Linking — Design Spec

**Date:** 2026-06-22  
**Project:** nodewatch  
**Status:** Approved

---

## Overview

Add the ability to schedule recurring connect/disconnect actions between AllStar nodes on a day-of-week + time basis. A new Schedule tab with a weekly grid view lets users create and manage these schedules without editing config files.

---

## Data Model

New `[[schedules]]` array in `config.toml`. Each entry:

```toml
[[schedules]]
label      = "Wednesday Net"
node       = 12345        # local node (must exist in [[nodes]])
remote     = 67890        # remote node to link to/from
days       = ["wed"]      # sun mon tue wed thu fri sat — multiple allowed
connect    = "19:00"      # HH:MM in [display] timezone
disconnect = "20:00"      # HH:MM — omit for connect-only with no auto-disconnect
mode       = "connect"    # connect | monitor | localmonitor
permanent  = false        # temporary (false) or permanent (true) ilink
enabled    = true         # toggle without deleting
```

Times are interpreted in `[display] timezone`. The scheduler works entirely in local time — no UTC conversion exposed to the user.

`config.toml` parsing and serialization in `server.ts` extended to handle the new `schedules` array via the existing `parseConfig` / `serializeConfig` functions.

---

## Scheduling Engine

A `runScheduler()` function added to `server.ts`, invoked once at startup after config is loaded.

```
startup
  └─ runScheduler()
       └─ setInterval(tick, 60_000)
            └─ tick():
                 current day  = e.g. "wed"   (display timezone)
                 current time = e.g. "19:00" (HH:MM, display timezone)
                 firedThisMinute = Set (cleared each tick)

                 for each schedule where enabled === true:
                   if current day ∈ schedule.days:
                     key_connect    = `${id}:connect:${currentTime}`
                     key_disconnect = `${id}:disconnect:${currentTime}`

                     if currentTime === schedule.connect
                       and key_connect not in firedThisMinute:
                         call ilink(connect, schedule.node, schedule.remote, schedule.mode, schedule.permanent)
                         add key_connect to firedThisMinute

                     if schedule.disconnect exists
                       and currentTime === schedule.disconnect
                       and key_disconnect not in firedThisMinute:
                         call ilink(disconnect, schedule.node, schedule.remote, schedule.permanent)
                         add key_disconnect to firedThisMinute
```

The tick reuses the same `ensureConnected` / `client.ilink` path already used by `/api/connect` and `/api/disconnect`. No HTTP round-trip — direct internal call. Errors are logged but do not crash the server.

The `firedThisMinute` set is scoped to each tick invocation (local variable), preventing double-fires if the interval drifts slightly.

---

## REST API

Two new endpoints (auth-gated, same as existing write endpoints):

### `GET /api/schedules`
Returns the current schedule list from in-memory config.

**Response:**
```json
{
  "schedules": [
    {
      "id": 0,
      "label": "Wednesday Net",
      "node": 12345,
      "remote": 67890,
      "days": ["wed"],
      "connect": "19:00",
      "disconnect": "20:00",
      "mode": "connect",
      "permanent": false,
      "enabled": true
    }
  ]
}
```

`id` is the array index — used by the UI to identify entries for edit/delete.

### `POST /api/schedules`
Replaces the full schedule list. Writes updated config to disk and hot-reloads `cfg.schedules` in memory (no server restart).

**Request body:**
```json
{ "schedules": [ /* full array */ ] }
```

**Response:** `{ "ok": true }`

---

## UI — Schedule Tab

New tab added between Favorites and Settings. Tab label: **Schedule**.

### Weekly Grid

- **Columns:** Sun · Mon · Tue · Wed · Thu · Fri · Sat (left to right)
- **Rows:** 00:00–23:45 in 15-minute slots (scrollable; auto-scrolls to 06:00 on load)
- **Blocks:** Each enabled schedule renders a colored block spanning its connect→disconnect window in every matching day column
  - Block content: `label` on first line, `→ remote node` on second line
  - If `disconnect` is omitted, block spans one 15-min slot
  - **Active highlight:** if current day+time falls within the block's window, it receives a distinct border/glow
- **Click on block:** opens Edit modal pre-populated with that entry's values
- **"＋ Add Schedule" button:** above the grid, opens Add modal with blank fields

### Add / Edit Modal

Fields:
| Field | Control |
|---|---|
| Label | text input |
| Local node | dropdown (populated from `[[nodes]]`) |
| Remote node | number input |
| Days | checkboxes: Sun Mon Tue Wed Thu Fri Sat |
| Connect time | `<input type="time">` |
| Disconnect time | `<input type="time">` (optional — clear to omit) |
| Mode | select: Connect / Monitor / Local Monitor |
| Permanent link | checkbox |
| Enabled | checkbox |

Actions:
- **Save** — POST full updated schedule list, close modal, re-render grid
- **Delete** (edit modal only) — removes entry, POST updated list, close modal
- **Cancel** — close modal, no change

### Error handling
- If a save fails, display inline error in modal; leave modal open
- If the server is unreachable, show error banner above grid

---

## Config Serialization

`serializeConfig()` in `server.ts` extended to append `[[schedules]]` blocks in the same TOML style as `[[commands]]`. `parseConfig()` reads `schedules` from the parsed TOML object (already handled by the TOML parser if the key exists; defaults to `[]` if absent).

---

## Out of Scope

- Sub-minute scheduling precision
- One-shot (non-recurring) schedules
- Notifications / alerts when a scheduled action fires
- Schedule history / audit log
