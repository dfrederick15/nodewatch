# Android Native nodewatch App — Design Spec

**Date:** 2026-06-24
**Status:** Approved

---

## Context

nodewatch (supermon-ts) is a web-based monitor and controller for AllStar Link ham radio repeater nodes. It exposes a REST + SSE API with cookie-based session auth. This spec covers a native Android companion app for monitoring live node status and performing core control actions (connect/disconnect nodes, send DTMF) over local network or VPN. A future cloud relay path for public internet access is out of scope here.

---

## Scope

**In scope (MVP):**
- Multi-server management (store and switch between nodewatch instances)
- Live node status dashboard driven by SSE
- Connect / disconnect nodes
- Send DTMF
- Favorites view

**Out of scope:**
- Settings editor
- Schedule editor
- Console log view
- Background notifications
- Cloud relay (future phase)

---

## Screens & Navigation

Single-activity app, Compose NavHost. Server List and Add/Edit Server are top-level destinations (no bottom nav). Inside a connected server, a bottom nav bar shows **Nodes | Favorites | Settings**.

| Screen | Purpose |
|---|---|
| Server List | Saved servers — tap to connect, long-press to edit/delete, FAB to add |
| Add/Edit Server | Name, host, port; on save → credential login → bearer token exchange |
| Dashboard | All local nodes: keyed state (color indicator), connection count; live via SSE |
| Node Detail | Full connection list (direction, mode, elapsed, keyed state); Connect + DTMF action buttons |
| Connect Sheet | Bottom sheet — remote node #, mode (Transceive / Monitor / Local Monitor), temp/permanent toggle |
| DTMF Dialpad | Bottom sheet — 12-key dialpad + send button |
| Favorites | Live status of favorited nodes |
| Server Settings | Rename server, re-authenticate, delete (revokes token on server) |

---

## Architecture

```
Compose Screens
    ↓ StateFlow<UiState>
ViewModel  (Android, lifecycle-aware)
    ↓
NodewatchRepository  (pure Kotlin — KMP-extractable)
    ↓
ApiClient (OkHttp REST)   +   SseClient (OkHttp streaming → Flow<ServerEvent>)
    ↓
EncryptedSharedPreferences (tokens, Keystore)  +  DataStore<Preferences> (server list)
```

### Pure-Kotlin boundary
`data/model/`, `data/remote/`, and `data/repository/` contain zero Android imports. They are extractable to a Kotlin Multiplatform module for a future iOS app with minimal refactoring.

### SSE Client
- Opens a persistent OkHttp streaming response to `/api/sse`
- `callbackFlow` reads lines, parses `event:`/`data:` pairs
- Emits sealed `ServerEvent`: `NodeStatus`, `NodeTimes`, `NodeError`, `ConsoleLine`
- Auto-reconnects with exponential backoff on disconnect
- Coroutine tied to `viewModelScope` — cancelled on background, reconnects on foreground

### Token Storage
- Each server entry gets a stable UUID
- `EncryptedSharedPreferences` stores `token_<uuid>` — backed by Android Keystore
- Server list (name, host, port, uuid) stored in plain `DataStore<Preferences>`

### Error Handling

| Scenario | Behavior |
|---|---|
| SSE disconnect | Silent reconnect; toast after 3 failures |
| REST 401 | Navigate to re-authenticate screen for that server |
| Control action error | Snackbar with error message; no optimistic state update |
| Server unreachable | Inline error on Server List card |

---

## Server-Side Changes Required

Three additions to the nodewatch server (`server.ts` + auth middleware):

1. **`POST /api/token`** — accepts `username`/`password`, creates a long-lived bearer token, persists it to `config.toml`. Returns `{ token: string, label: string }`.
2. **Auth middleware** — accept `Authorization: Bearer <token>` header alongside `asl_session` cookies. Same permission level as an authenticated session.
3. **`DELETE /api/token`** — revoke a specific token by value (called when user deletes a server from the Android app).

**Token format:** 32 random bytes as hex (consistent with existing session tokens).
**Persistence:** `[[mobile_tokens]]` array in `config.toml`, each entry has `token` and `label` (device name) fields.

---

## Key Libraries

| Library | Purpose |
|---|---|
| Jetpack Compose + Material 3 | Declarative UI |
| Navigation Compose | Screen routing (NavHost) |
| OkHttp 4 | HTTP REST calls + SSE streaming |
| Kotlinx Coroutines + Flow | Async operations, SSE as Flow |
| Jetpack DataStore | Server list persistence |
| Jetpack Security (EncryptedSharedPreferences) | Token storage backed by Android Keystore |
| Hilt | Dependency injection |
| ViewModel + Lifecycle | MVVM lifecycle management |

---

## Project Structure

```
android/                              ← new top-level dir in supermon repo
  app/
    src/main/kotlin/com/nodewatch/
      data/
        model/                        ← pure Kotlin: ServerEvent, NodeStatus, Connection, Server
        remote/
          ApiClient.kt                ← pure Kotlin: REST methods
          SseClient.kt                ← pure Kotlin: Flow<ServerEvent>
        repository/
          NodewatchRepository.kt      ← pure Kotlin: combines ApiClient + SseClient
        storage/
          ServerStore.kt              ← Android: DataStore wrapper
          TokenStore.kt               ← Android: EncryptedSharedPreferences wrapper
      ui/
        screens/
          ServerListScreen.kt
          AddServerScreen.kt
          DashboardScreen.kt
          NodeDetailScreen.kt
          FavoritesScreen.kt
          ServerSettingsScreen.kt
        components/
          NodeCard.kt
          ConnectionRow.kt
          ConnectSheet.kt
          DtmfDialpad.kt
        theme/
          Theme.kt
      di/
        AppModule.kt
        NetworkModule.kt
      MainActivity.kt
      NavGraph.kt
  build.gradle.kts
  settings.gradle.kts
```

---

## Testing

- **Unit (JVM, no Android runtime):** SSE line parsing in `SseClient`, `NodewatchRepository` state transitions, JSON model parsing
- **Instrumented (emulator):** `TokenStore` read/write round-trip, Compose navigation flows via `TestNavHostController`
- **Manual end-to-end:** Device on same LAN as running nodewatch → add server → live dashboard SSE updates → connect node → disconnect → DTMF → token persists across app restart

---

## Verification Steps

1. Start nodewatch: `node --experimental-strip-types server.ts` in supermon repo
2. Install debug APK on Android device on same network
3. Add server (LAN IP, port 8080) → authenticate → token stored
4. Dashboard loads; SSE events update node keyed state live
5. Connect action links two nodes; confirmed in nodewatch web UI
6. Disconnect and DTMF actions work correctly
7. Add a second server; switching between servers works
8. Kill and reopen app → no re-login required (token persists)
