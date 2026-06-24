# Android nodewatch App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native Android app (Kotlin + Jetpack Compose) that connects to one or more nodewatch servers over LAN/VPN to monitor AllStar Link nodes live and perform connect/disconnect/DTMF actions.

**Architecture:** Single-module MVVM. Pure-Kotlin data layer (models, ApiClient, SseClient, Repository — zero Android imports) sits under Android-specific ViewModels and Compose screens. Server-side adds bearer token auth so the app doesn't need to re-login on session expiry.

**Tech Stack:** Kotlin 2.x, Jetpack Compose + Material 3, Navigation Compose, OkHttp 4, kotlinx.serialization, Kotlinx Coroutines + Flow, Jetpack DataStore, Jetpack Security (EncryptedSharedPreferences), Hilt, ViewModel + Lifecycle.

## Global Constraints

- Android minSdk 26, targetSdk 35, compileSdk 35
- Package name: `com.nodewatch.app`
- Android project root: `android/` inside the supermon repo
- All data/model/remote/repository code: zero Android imports (KMP-extractable)
- No background services — SSE coroutine tied to `viewModelScope`
- Server base URL format: `http://<host>:<port>` (HTTPS is a future concern)
- Bearer token header: `Authorization: Bearer <token>`
- kotlinx.serialization for all JSON; use `@SerialName` where JSON key differs from property name

---

## Phase 1 — Server-side Token API (modifies `server.ts`)

### Task 1: Bearer token issuance + auth middleware

**Files:**
- Modify: `server.ts`

**Interfaces:**
- Produces: `POST /api/token` → `{ token: string }`, bearer auth accepted by `requireAuth`

- [ ] **Step 1: Add `MobileToken` interface and update `Config`**

In `server.ts`, after the `Config` interface (line ~139), add:

```typescript
interface MobileToken {
  token: string;
  label: string;     // device name, for display in settings
  created: number;   // Unix ms
}
```

Add `mobile_tokens?: MobileToken[];` to the `Config` interface:

```typescript
interface Config {
  // ... existing fields ...
  mobile_tokens?: MobileToken[];
}
```

- [ ] **Step 2: Add in-memory token store and load from config**

After the `sessions` Map (line ~317), add:

```typescript
// ── Mobile token store ────────────────────────────────────────────────────────
// Long-lived bearer tokens for the Android/iOS app. Persisted to config.toml.
const mobileTokens = new Map<string, MobileToken>();

function loadMobileTokens(): void {
  for (const t of cfg.mobile_tokens ?? []) {
    mobileTokens.set(t.token, t);
  }
}
loadMobileTokens();
```

- [ ] **Step 3: Update `requireAuth` to accept bearer tokens**

Replace the existing `requireAuth` function (line ~719):

```typescript
function tokenFromReq(req: http.IncomingMessage): string | undefined {
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
}

function isAuthedReq(req: http.IncomingMessage): boolean {
  const bearer = tokenFromReq(req);
  if (bearer && mobileTokens.has(bearer)) return true;
  return !!sessionFromReq(req);
}

function requireAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (isAuthedReq(req)) return true;
  json(res, 401, { error: "Not logged in" });
  return false;
}
```

Update all callers: `requireAuth` now returns `boolean` instead of `Session | null`. Find every `if (!requireAuth(req, res)) return;` — those still work. But any place that uses the returned Session object needs adjustment. Check with:

```bash
grep -n "requireAuth" server.ts
```

The only caller that used the return value for session data was `GET /api/settings` to return `must_change_password` — that field can now use `sessionFromReq` directly as a fallback.

- [ ] **Step 4: Update `serializeConfig` to persist mobile tokens**

In `serializeConfig`, after the schedules loop (line ~218), add:

```typescript
  for (const t of c.mobile_tokens ?? []) {
    L.push("[[mobile_tokens]]");
    L.push(`token   = ${tomlStr(t.token)}`);
    L.push(`label   = ${tomlStr(t.label)}`);
    L.push(`created = ${t.created}`);
    L.push("");
  }
```

- [ ] **Step 5: Add `POST /api/token` handler**

In the HTTP server handler, after the `/api/logout` block (line ~756), add:

```typescript
  if (pathname === "/api/token" && req.method === "POST") {
    const body = await readBody(req);
    if (body.username !== cfg.auth.username || body.password !== cfg.auth.password) {
      json(res, 401, { error: "Invalid credentials" });
      return;
    }
    const token = crypto.randomBytes(32).toString("hex");
    const label = (body.label ?? "Mobile").slice(0, 64);
    const entry: MobileToken = { token, label, created: Date.now() };
    mobileTokens.set(token, entry);
    cfg.mobile_tokens = [...(cfg.mobile_tokens ?? []), entry];
    fs.writeFileSync(configPath, serializeConfig(cfg), "utf8");
    json(res, 200, { token });
    return;
  }
```

- [ ] **Step 6: Update SSE auth check to also accept bearer tokens**

The SSE client struct uses `authed: boolean`. Find the SSE connect handler (line ~968):

```typescript
    const sseSession = sessionFromReq(req);
    // ...
    const client: SSEClient = { res, authed: !!sseSession };
```

Update to:

```typescript
    const client: SSEClient = { res, authed: isAuthedReq(req) };
```

- [ ] **Step 7: Restart server and verify with curl**

```bash
# Start server
node --experimental-strip-types server.ts &

# Get a token
curl -s -X POST http://localhost:8080/api/token \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"changeme","label":"test"}'
# Expected: {"token":"<64-char hex>"}

# Use the token
TOKEN=<paste token here>
curl -s http://localhost:8080/api/settings \
  -H "Authorization: Bearer $TOKEN"
# Expected: full config JSON (not 401)

# Bad token
curl -s http://localhost:8080/api/settings \
  -H "Authorization: Bearer badtoken"
# Expected: {"error":"Not logged in"}
```

- [ ] **Step 8: Commit**

```bash
git add server.ts
git commit -m "feat: add mobile bearer token API (POST /api/token)"
```

---

### Task 2: Token revocation (`DELETE /api/token`)

**Files:**
- Modify: `server.ts`

**Interfaces:**
- Produces: `DELETE /api/token` (auth required, revokes the caller's own bearer token)

- [ ] **Step 1: Add `DELETE /api/token` handler**

After the `POST /api/token` block, add:

```typescript
  if (pathname === "/api/token" && req.method === "DELETE") {
    const bearer = tokenFromReq(req);
    if (!bearer || !mobileTokens.has(bearer)) {
      json(res, 401, { error: "Not logged in" });
      return;
    }
    mobileTokens.delete(bearer);
    cfg.mobile_tokens = (cfg.mobile_tokens ?? []).filter(t => t.token !== bearer);
    fs.writeFileSync(configPath, serializeConfig(cfg), "utf8");
    json(res, 200, { ok: true });
    return;
  }
```

- [ ] **Step 2: Verify with curl**

```bash
TOKEN=<token from Task 1 step 7>

# Revoke
curl -s -X DELETE http://localhost:8080/api/token \
  -H "Authorization: Bearer $TOKEN"
# Expected: {"ok":true}

# Token no longer works
curl -s http://localhost:8080/api/settings \
  -H "Authorization: Bearer $TOKEN"
# Expected: {"error":"Not logged in"}

# Verify config.toml no longer has the token
grep "mobile_tokens" config.toml
# Expected: no output (or empty section if other tokens exist)
```

- [ ] **Step 3: Kill background server and commit**

```bash
kill %1
git add server.ts
git commit -m "feat: add DELETE /api/token for bearer token revocation"
```

---

## Phase 2 — Android Project Scaffold

### Task 3: Gradle setup and dependencies

**Files:**
- Create: `android/settings.gradle.kts`
- Create: `android/build.gradle.kts`
- Create: `android/app/build.gradle.kts`
- Create: `android/gradle.properties`
- Create: `android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Create `android/settings.gradle.kts`**

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "nodewatch"
include(":app")
```

- [ ] **Step 2: Create `android/build.gradle.kts`**

```kotlin
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.hilt) apply false
    alias(libs.plugins.ksp) apply false
}
```

- [ ] **Step 3: Create `android/app/src/main/res/values/themes.xml`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.Nodewatch" parent="Theme.Material3.DayNight.NoActionBar" />
</resources>
```

Update `AndroidManifest.xml` `android:theme` attribute to `@style/Theme.Nodewatch` (not `@style/Theme.AppCompat.DayNight.NoActionBar`).

- [ ] **Step 4: Create `android/gradle/libs.versions.toml`**

```toml
[versions]
agp = "8.5.2"
kotlin = "2.0.21"
ksp = "2.0.21-1.0.27"
hilt = "2.52"
compose-bom = "2024.10.01"
navigation = "2.8.3"
lifecycle = "2.8.6"
okhttp = "4.12.0"
kotlinx-serialization = "1.7.3"
kotlinx-coroutines = "1.9.0"
datastore = "1.1.1"
security-crypto = "1.1.0-alpha06"

[libraries]
# Compose BOM
compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "compose-bom" }
compose-ui = { group = "androidx.compose.ui", name = "ui" }
compose-ui-tooling-preview = { group = "androidx.compose.ui", name = "ui-tooling-preview" }
compose-ui-tooling = { group = "androidx.compose.ui", name = "ui-tooling" }
compose-material3 = { group = "androidx.compose.material3", name = "material3" }
compose-icons-extended = { group = "androidx.compose.material", name = "material-icons-extended" }
# Navigation
navigation-compose = { group = "androidx.navigation", name = "navigation-compose", version.ref = "navigation" }
# Lifecycle
lifecycle-viewmodel-compose = { group = "androidx.lifecycle", name = "lifecycle-viewmodel-compose", version.ref = "lifecycle" }
lifecycle-runtime-compose = { group = "androidx.lifecycle", name = "lifecycle-runtime-compose", version.ref = "lifecycle" }
# Hilt
hilt-android = { group = "com.google.dagger", name = "hilt-android", version.ref = "hilt" }
hilt-compiler = { group = "com.google.dagger", name = "hilt-android-compiler", version.ref = "hilt" }
hilt-navigation-compose = { group = "androidx.hilt", name = "hilt-navigation-compose", version = "1.2.0" }
# OkHttp
okhttp = { group = "com.squareup.okhttp3", name = "okhttp", version.ref = "okhttp" }
okhttp-logging = { group = "com.squareup.okhttp3", name = "logging-interceptor", version.ref = "okhttp" }
# Serialization
kotlinx-serialization-json = { group = "org.jetbrains.kotlinx", name = "kotlinx-serialization-json", version.ref = "kotlinx-serialization" }
# Coroutines
kotlinx-coroutines-android = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-android", version.ref = "kotlinx-coroutines" }
# Storage
datastore-preferences = { group = "androidx.datastore", name = "datastore-preferences", version.ref = "datastore" }
security-crypto = { group = "androidx.security", name = "security-crypto", version.ref = "security-crypto" }
# Test
junit = { group = "junit", name = "junit", version = "4.13.2" }
mockk = { group = "io.mockk", name = "mockk", version = "1.13.12" }
kotlinx-coroutines-test = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-test", version.ref = "kotlinx-coroutines" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version.ref = "kotlin" }
hilt = { id = "com.google.dagger.hilt.android", version.ref = "hilt" }
ksp = { id = "com.google.devtools.ksp", version.ref = "ksp" }
```

- [ ] **Step 4: Create `android/app/build.gradle.kts`**

```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.nodewatch.app"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.nodewatch.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}

dependencies {
    val composeBom = platform(libs.compose.bom)
    implementation(composeBom)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.icons.extended)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.navigation.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)

    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.hilt.navigation.compose)

    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.datastore.preferences)
    implementation(libs.security.crypto)

    implementation(libs.material)

    testImplementation(libs.junit)
    testImplementation(libs.mockk)
    testImplementation(libs.kotlinx.coroutines.test)
}
```

- [ ] **Step 5: Create `android/gradle.properties`**

```properties
android.useAndroidX=true
kotlin.code.style=official
android.nonTransitiveRClass=true
```

- [ ] **Step 6: Create `android/app/src/main/AndroidManifest.xml`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:name=".NodewatchApp"
        android:label="nodewatch"
        android:theme="@style/Theme.AppCompat.DayNight.NoActionBar"
        android:allowBackup="true">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

- [ ] **Step 7: Create Hilt Application class**

`android/app/src/main/kotlin/com/nodewatch/app/NodewatchApp.kt`:

```kotlin
package com.nodewatch.app

import android.app.Application
import dagger.hilt.android.HiltAndroidApp

@HiltAndroidApp
class NodewatchApp : Application()
```

- [ ] **Step 8: Create `MainActivity.kt` stub**

`android/app/src/main/kotlin/com/nodewatch/app/MainActivity.kt`:

```kotlin
package com.nodewatch.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.nodewatch.app.ui.theme.NodewatchTheme
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            NodewatchTheme {
                // NavGraph goes here in Task 10
            }
        }
    }
}
```

- [ ] **Step 9: Download Gradle wrapper and verify build**

```bash
cd android
gradle wrapper --gradle-version 8.9
./gradlew assembleDebug
# Expected: BUILD SUCCESSFUL
```

- [ ] **Step 10: Commit**

```bash
git add android/
git commit -m "feat: scaffold Android project with Compose + Hilt"
```

---

## Phase 3 — Data Models

### Task 4: Pure-Kotlin data models

**Files:**
- Create: `android/app/src/main/kotlin/com/nodewatch/app/data/model/Server.kt`
- Create: `android/app/src/main/kotlin/com/nodewatch/app/data/model/ServerEvent.kt`
- Test: `android/app/src/test/kotlin/com/nodewatch/app/data/model/ServerEventTest.kt`

**Interfaces:**
- Produces: `Server`, `ServerEvent` (sealed), `NodeStatus`, `Connection`, `SubnodeEntry`, `NodeTimes`, `FavoriteStatus`

- [ ] **Step 1: Write the failing test for SSE JSON parsing**

`android/app/src/test/kotlin/com/nodewatch/app/data/model/ServerEventTest.kt`:

```kotlin
package com.nodewatch.app.data.model

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerEventTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `parses node_status event`() {
        val data = """{"node":"1234","cos_keyed":false,"tx_keyed":true,"connections":[]}"""
        val event = ServerEvent.fromSse("node_status", data, json)
        assertTrue(event is ServerEvent.NodeStatusEvent)
        val ns = (event as ServerEvent.NodeStatusEvent).status
        assertEquals("1234", ns.node)
        assertEquals(true, ns.txKeyed)
    }

    @Test
    fun `parses node_times event`() {
        val data = """{"node":"1234","connections":[{"node":"5678","elapsed":120,"last_keyed":5}]}"""
        val event = ServerEvent.fromSse("node_times", data, json)
        assertTrue(event is ServerEvent.NodeTimesEvent)
        val nt = (event as ServerEvent.NodeTimesEvent).times
        assertEquals("1234", nt.node)
        assertEquals(1, nt.connections.size)
        assertEquals(120, nt.connections[0].elapsed)
    }

    @Test
    fun `parses node_error event`() {
        val data = """{"node":"1234","error":"connection refused"}"""
        val event = ServerEvent.fromSse("node_error", data, json)
        assertTrue(event is ServerEvent.NodeErrorEvent)
        assertEquals("connection refused", (event as ServerEvent.NodeErrorEvent).error)
    }

    @Test
    fun `unknown event type returns Unknown`() {
        val event = ServerEvent.fromSse("future_event", "{}", json)
        assertTrue(event is ServerEvent.Unknown)
    }
}
```

- [ ] **Step 2: Run test — expect compile failure (models not yet defined)**

```bash
cd android && ./gradlew :app:test --tests "*.ServerEventTest" 2>&1 | tail -20
# Expected: compilation error — ServerEvent not found
```

- [ ] **Step 3: Create `Server.kt`**

```kotlin
package com.nodewatch.app.data.model

import java.util.UUID

data class Server(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val host: String,
    val port: Int = 8080,
) {
    val baseUrl: String get() = "http://$host:$port"
}
```

- [ ] **Step 4: Create `ServerEvent.kt`**

```kotlin
package com.nodewatch.app.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class SubnodeEntry(
    val node: String,
    val info: String,
)

@Serializable
data class Connection(
    val node: String,
    val ip: String,
    val direction: String,
    val elapsed: Int,
    val link: String,
    val mode: String,
    val keyed: Boolean,
    @SerialName("last_keyed") val lastKeyed: Int,
    @SerialName("cos_keyed") val cosKeyed: Boolean,
    @SerialName("tx_keyed") val txKeyed: Boolean,
    val info: String = "",
    val subnodes: List<SubnodeEntry> = emptyList(),
)

@Serializable
data class NodeStatus(
    val node: String,
    @SerialName("cos_keyed") val cosKeyed: Boolean,
    @SerialName("tx_keyed") val txKeyed: Boolean,
    val connections: List<Connection> = emptyList(),
    val error: String? = null,
)

@Serializable
data class ConnectionTiming(
    val node: String,
    val elapsed: Int,
    @SerialName("last_keyed") val lastKeyed: Int,
)

@Serializable
data class NodeTimes(
    val node: String,
    val connections: List<ConnectionTiming>,
)

@Serializable
data class FavoriteNodeStatus(
    val node: String,
    @SerialName("callsign") val callsign: String = "",
    @SerialName("connected") val connected: Boolean = false,
)

sealed class ServerEvent {
    data class NodeStatusEvent(val status: NodeStatus) : ServerEvent()
    data class NodeTimesEvent(val times: NodeTimes) : ServerEvent()
    data class NodeErrorEvent(val node: String, val error: String) : ServerEvent()
    data class Unknown(val type: String) : ServerEvent()

    companion object {
        @Serializable
        private data class NodeErrorPayload(val node: String, val error: String)

        fun fromSse(eventType: String, data: String, json: Json): ServerEvent = when (eventType) {
            "node_status" -> NodeStatusEvent(json.decodeFromString(data))
            "node_times"  -> NodeTimesEvent(json.decodeFromString(data))
            "node_error"  -> {
                val p = json.decodeFromString<NodeErrorPayload>(data)
                NodeErrorEvent(p.node, p.error)
            }
            else -> Unknown(eventType)
        }
    }
}
```

- [ ] **Step 5: Run test — expect pass**

```bash
cd android && ./gradlew :app:test --tests "*.ServerEventTest"
# Expected: BUILD SUCCESSFUL, 4 tests passed
```

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/kotlin/com/nodewatch/app/data/model/ \
        android/app/src/test/kotlin/com/nodewatch/app/data/model/
git commit -m "feat: add Android data models (ServerEvent, NodeStatus, Connection)"
```

---

## Phase 4 — Network Layer

### Task 5: SseClient

**Files:**
- Create: `android/app/src/main/kotlin/com/nodewatch/app/data/remote/SseClient.kt`
- Test: `android/app/src/test/kotlin/com/nodewatch/app/data/remote/SseClientTest.kt`

**Interfaces:**
- Consumes: `Server`, `ServerEvent.fromSse()`
- Produces: `SseClient.events(server, token): Flow<ServerEvent>`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.nodewatch.app.data.remote

import com.nodewatch.app.data.model.Server
import com.nodewatch.app.data.model.ServerEvent
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class SseClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: SseClient

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
        client = SseClient(OkHttpClient())
    }

    @After fun tearDown() { server.shutdown() }

    @Test
    fun `emits NodeStatusEvent from SSE stream`() = runTest {
        val body = "event: node_status\ndata: {\"node\":\"1234\",\"cos_keyed\":false,\"tx_keyed\":false,\"connections\":[]}\n\n"
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .addHeader("Content-Type", "text/event-stream")
                .setBody(body)
        )
        val s = Server(host = server.hostName, port = server.port, name = "test")
        val event = client.events(s, "token").first()
        assertTrue(event is ServerEvent.NodeStatusEvent)
    }
}
```

- [ ] **Step 2: Run test — expect compile failure**

```bash
cd android && ./gradlew :app:test --tests "*.SseClientTest" 2>&1 | tail -5
# Expected: compilation error — SseClient not found
```

Add `mockwebserver` to `libs.versions.toml` under `[libraries]`:
```toml
mockwebserver = { group = "com.squareup.okhttp3", name = "mockwebserver", version.ref = "okhttp" }
material = { group = "com.google.android.material", name = "material", version = "1.12.0" }
```
Add to `app/build.gradle.kts` test dependencies:
```kotlin
testImplementation(libs.mockwebserver)
```

- [ ] **Step 3: Implement `SseClient.kt`**

```kotlin
package com.nodewatch.app.data.remote

import com.nodewatch.app.data.model.Server
import com.nodewatch.app.data.model.ServerEvent
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import javax.inject.Inject

class SseClient @Inject constructor(private val okhttp: OkHttpClient) {

    private val json = Json { ignoreUnknownKeys = true }

    fun events(server: Server, token: String): Flow<ServerEvent> = callbackFlow {
        var backoffMs = 1_000L
        while (true) {
            val request = Request.Builder()
                .url("${server.baseUrl}/api/sse")
                .header("Authorization", "Bearer $token")
                .header("Accept", "text/event-stream")
                .build()
            try {
                okhttp.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        delay(backoffMs)
                        backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
                        return@use
                    }
                    backoffMs = 1_000L
                    val source = response.body!!.source()
                    var eventType = ""
                    var dataLine = ""
                    while (!source.exhausted()) {
                        val line = source.readUtf8Line() ?: break
                        when {
                            line.startsWith("event:") -> eventType = line.removePrefix("event:").trim()
                            line.startsWith("data:")  -> dataLine  = line.removePrefix("data:").trim()
                            line.isEmpty() && eventType.isNotEmpty() && dataLine.isNotEmpty() -> {
                                runCatching { trySend(ServerEvent.fromSse(eventType, dataLine, json)) }
                                eventType = ""; dataLine = ""
                            }
                        }
                    }
                }
            } catch (_: IOException) {
                delay(backoffMs)
                backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
            }
        }
        awaitClose()
    }
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
cd android && ./gradlew :app:test --tests "*.SseClientTest"
# Expected: BUILD SUCCESSFUL
```

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/kotlin/com/nodewatch/app/data/remote/SseClient.kt \
        android/app/src/test/kotlin/com/nodewatch/app/data/remote/SseClientTest.kt \
        android/gradle/libs.versions.toml android/app/build.gradle.kts
git commit -m "feat: add SseClient — OkHttp streaming SSE as Kotlin Flow"
```

---

### Task 6: ApiClient

**Files:**
- Create: `android/app/src/main/kotlin/com/nodewatch/app/data/remote/ApiClient.kt`
- Test: `android/app/src/test/kotlin/com/nodewatch/app/data/remote/ApiClientTest.kt`

**Interfaces:**
- Consumes: `Server`, bearer token string
- Produces:
  - `suspend fun login(server, username, password, label): Result<String>` — returns token
  - `suspend fun getNodeStatuses(server, token): Result<List<NodeStatus>>`
  - `suspend fun connect(server, token, localNode, remoteNode, mode, permanent): Result<Unit>`
  - `suspend fun disconnect(server, token, localNode, remoteNode, permanent): Result<Unit>`
  - `suspend fun sendDtmf(server, token, node, digits): Result<Unit>`
  - `suspend fun getFavoriteStatuses(server, token): Result<List<FavoriteNodeStatus>>`
  - `suspend fun revokeToken(server, token): Result<Unit>`

- [ ] **Step 1: Write failing tests**

```kotlin
package com.nodewatch.app.data.remote

import com.nodewatch.app.data.model.Server
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class ApiClientTest {
    private lateinit var mockServer: MockWebServer
    private lateinit var client: ApiClient
    private lateinit var server: Server

    @Before fun setUp() {
        mockServer = MockWebServer()
        mockServer.start()
        client = ApiClient(OkHttpClient())
        server = Server(host = mockServer.hostName, port = mockServer.port, name = "test")
    }

    @After fun tearDown() { mockServer.shutdown() }

    @Test
    fun `login returns token on 200`() = runTest {
        mockServer.enqueue(MockResponse().setResponseCode(200).setBody("""{"token":"abc123"}"""))
        val result = client.login(server, "admin", "pass", "TestDevice")
        assertTrue(result.isSuccess)
        assertEquals("abc123", result.getOrNull())
    }

    @Test
    fun `login returns failure on 401`() = runTest {
        mockServer.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"Invalid credentials"}"""))
        val result = client.login(server, "admin", "wrong", "TestDevice")
        assertTrue(result.isFailure)
    }

    @Test
    fun `connect sends correct ilink code for transceive temp`() = runTest {
        mockServer.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client.connect(server, "token", "1234", "5678", ConnectMode.TRANSCEIVE, permanent = false)
        val req = mockServer.takeRequest()
        assertEquals("POST", req.method)
        assertTrue(req.body.readUtf8().contains("\"mode\":\"transceive\""))
    }
}
```

- [ ] **Step 2: Run test — expect compile failure**

```bash
cd android && ./gradlew :app:test --tests "*.ApiClientTest" 2>&1 | tail -5
```

- [ ] **Step 3: Implement `ApiClient.kt`**

```kotlin
package com.nodewatch.app.data.remote

import com.nodewatch.app.data.model.FavoriteNodeStatus
import com.nodewatch.app.data.model.NodeStatus
import com.nodewatch.app.data.model.Server
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import javax.inject.Inject

enum class ConnectMode { TRANSCEIVE, MONITOR, LOCAL_MONITOR }

class ApiClient @Inject constructor(private val okhttp: OkHttpClient) {

    private val json = Json { ignoreUnknownKeys = true }
    private val JSON_MT = "application/json; charset=utf-8".toMediaType()

    private fun authHeader(token: String) = "Bearer $token"

    private suspend fun post(url: String, token: String?, body: String): okhttp3.Response {
        val req = Request.Builder()
            .url(url)
            .post(body.toRequestBody(JSON_MT))
            .apply { if (token != null) header("Authorization", authHeader(token)) }
            .build()
        return okhttp.newCall(req).execute()
    }

    private suspend fun delete(url: String, token: String): okhttp3.Response {
        val req = Request.Builder()
            .url(url)
            .delete()
            .header("Authorization", authHeader(token))
            .build()
        return okhttp.newCall(req).execute()
    }

    private suspend fun get(url: String, token: String): okhttp3.Response {
        val req = Request.Builder()
            .url(url)
            .get()
            .header("Authorization", authHeader(token))
            .build()
        return okhttp.newCall(req).execute()
    }

    suspend fun login(server: Server, username: String, password: String, label: String): Result<String> =
        runCatching {
            @Serializable data class Body(val username: String, val password: String, val label: String)
            val resp = post("${server.baseUrl}/api/token", null, json.encodeToString(Body(username, password, label)))
            if (!resp.isSuccessful) error("HTTP ${resp.code}")
            val parsed = Json.parseToJsonElement(resp.body!!.string()).jsonObject
            parsed["token"]!!.jsonPrimitive.content
        }

    suspend fun getNodeStatuses(server: Server, token: String): Result<List<NodeStatus>> =
        runCatching {
            // Read from the last known status via config endpoint; SSE is the primary channel.
            // For initial load, we trigger a single poll via GET /api/config (returns node list)
            // then rely on SSE for live status. The actual status is held in lastStatus on the server
            // and replayed on SSE connect. So this is a no-op for initial data — the ViewModel
            // collects from the SSE flow which replays current status on connect.
            emptyList()
        }

    suspend fun connect(
        server: Server, token: String,
        localNode: String, remoteNode: String,
        mode: ConnectMode, permanent: Boolean,
    ): Result<Unit> = runCatching {
        @Serializable data class Body(
            val node: String, val remote: String, val mode: String, val permanent: Boolean,
        )
        val modeStr = when (mode) {
            ConnectMode.TRANSCEIVE    -> "transceive"
            ConnectMode.MONITOR       -> "monitor"
            ConnectMode.LOCAL_MONITOR -> "localmonitor"
        }
        val resp = post("${server.baseUrl}/api/connect", token, json.encodeToString(Body(localNode, remoteNode, modeStr, permanent)))
        if (!resp.isSuccessful) error("HTTP ${resp.code}: ${resp.body?.string()}")
    }

    suspend fun disconnect(
        server: Server, token: String,
        localNode: String, remoteNode: String, permanent: Boolean,
    ): Result<Unit> = runCatching {
        @Serializable data class Body(val node: String, val remote: String, val permanent: Boolean)
        val resp = post("${server.baseUrl}/api/disconnect", token, json.encodeToString(Body(localNode, remoteNode, permanent)))
        if (!resp.isSuccessful) error("HTTP ${resp.code}: ${resp.body?.string()}")
    }

    suspend fun sendDtmf(server: Server, token: String, node: String, digits: String): Result<Unit> = runCatching {
        @Serializable data class Body(val node: String, val digits: String)
        val resp = post("${server.baseUrl}/api/dtmf", token, json.encodeToString(Body(node, digits)))
        if (!resp.isSuccessful) error("HTTP ${resp.code}: ${resp.body?.string()}")
    }

    suspend fun getFavoriteStatuses(server: Server, token: String): Result<List<FavoriteNodeStatus>> = runCatching {
        val resp = get("${server.baseUrl}/api/favorites/status", token)
        if (!resp.isSuccessful) error("HTTP ${resp.code}")
        val arr = Json.parseToJsonElement(resp.body!!.string()).jsonArray
        arr.map { el ->
            val o = el.jsonObject
            FavoriteNodeStatus(
                node = o["node"]!!.jsonPrimitive.content,
                callsign = o["callsign"]?.jsonPrimitive?.content ?: "",
                connected = o["connected"]?.jsonPrimitive?.content?.toBoolean() ?: false,
            )
        }
    }

    suspend fun revokeToken(server: Server, token: String): Result<Unit> = runCatching {
        val resp = delete("${server.baseUrl}/api/token", token)
        if (!resp.isSuccessful) error("HTTP ${resp.code}")
    }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd android && ./gradlew :app:test --tests "*.ApiClientTest"
# Expected: BUILD SUCCESSFUL
```

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/kotlin/com/nodewatch/app/data/remote/ApiClient.kt \
        android/app/src/test/kotlin/com/nodewatch/app/data/remote/ApiClientTest.kt
git commit -m "feat: add ApiClient (login, connect, disconnect, DTMF, favorites, revoke)"
```

---

## Phase 5 — Storage + Repository

### Task 7: Storage layer

**Files:**
- Create: `android/app/src/main/kotlin/com/nodewatch/app/data/storage/ServerStore.kt`
- Create: `android/app/src/main/kotlin/com/nodewatch/app/data/storage/TokenStore.kt`

**Interfaces:**
- Produces:
  - `ServerStore.servers: Flow<List<Server>>`
  - `suspend ServerStore.save(server: Server)`
  - `suspend ServerStore.delete(id: String)`
  - `suspend ServerStore.update(server: Server)`
  - `TokenStore.getToken(serverId: String): String?`
  - `suspend TokenStore.setToken(serverId: String, token: String)`
  - `suspend TokenStore.deleteToken(serverId: String)`

- [ ] **Step 1: Implement `ServerStore.kt`**

```kotlin
package com.nodewatch.app.data.storage

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.nodewatch.app.data.model.Server
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Singleton

private val Context.dataStore by preferencesDataStore("servers")

@Singleton
class ServerStore @Inject constructor(@ApplicationContext private val ctx: Context) {

    private val KEY = stringPreferencesKey("server_list")

    val servers: Flow<List<Server>> = ctx.dataStore.data.map { prefs ->
        val raw = prefs[KEY] ?: return@map emptyList()
        runCatching { Json.decodeFromString<List<Server>>(raw) }.getOrDefault(emptyList())
    }

    suspend fun save(server: Server) = edit { list -> list + server }
    suspend fun update(server: Server) = edit { list -> list.map { if (it.id == server.id) server else it } }
    suspend fun delete(id: String) = edit { list -> list.filter { it.id != id } }

    private suspend fun edit(transform: (List<Server>) -> List<Server>) {
        ctx.dataStore.edit { prefs ->
            val current = runCatching {
                Json.decodeFromString<List<Server>>(prefs[KEY] ?: "[]")
            }.getOrDefault(emptyList())
            prefs[KEY] = Json.encodeToString(transform(current))
        }
    }
}
```

- [ ] **Step 2: Implement `TokenStore.kt`**

```kotlin
package com.nodewatch.app.data.storage

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class TokenStore @Inject constructor(@ApplicationContext private val ctx: Context) {

    private val prefs by lazy {
        val master = MasterKey.Builder(ctx)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            ctx, "nodewatch_tokens", master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun getToken(serverId: String): String? = prefs.getString(serverId, null)

    suspend fun setToken(serverId: String, token: String) {
        prefs.edit().putString(serverId, token).apply()
    }

    suspend fun deleteToken(serverId: String) {
        prefs.edit().remove(serverId).apply()
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/kotlin/com/nodewatch/app/data/storage/
git commit -m "feat: add ServerStore (DataStore) and TokenStore (EncryptedSharedPreferences)"
```

---

### Task 8: NodewatchRepository + Hilt modules

**Files:**
- Create: `android/app/src/main/kotlin/com/nodewatch/app/data/repository/NodewatchRepository.kt`
- Create: `android/app/src/main/kotlin/com/nodewatch/app/di/AppModule.kt`

**Interfaces:**
- Consumes: `ApiClient`, `SseClient`, `ServerStore`, `TokenStore`
- Produces:
  - `fun NodewatchRepository.nodeEvents(server): Flow<ServerEvent>`
  - `suspend fun NodewatchRepository.login(server, user, pass, label): Result<Unit>`
  - `suspend fun NodewatchRepository.connect(server, localNode, remoteNode, mode, permanent): Result<Unit>`
  - `suspend fun NodewatchRepository.disconnect(server, localNode, remoteNode, permanent): Result<Unit>`
  - `suspend fun NodewatchRepository.sendDtmf(server, node, digits): Result<Unit>`
  - `suspend fun NodewatchRepository.deleteServer(server): Result<Unit>`

- [ ] **Step 1: Implement `NodewatchRepository.kt`**

```kotlin
package com.nodewatch.app.data.repository

import com.nodewatch.app.data.model.FavoriteNodeStatus
import com.nodewatch.app.data.model.Server
import com.nodewatch.app.data.model.ServerEvent
import com.nodewatch.app.data.remote.ApiClient
import com.nodewatch.app.data.remote.ConnectMode
import com.nodewatch.app.data.remote.SseClient
import com.nodewatch.app.data.storage.ServerStore
import com.nodewatch.app.data.storage.TokenStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class NodewatchRepository @Inject constructor(
    private val api: ApiClient,
    private val sse: SseClient,
    private val serverStore: ServerStore,
    private val tokenStore: TokenStore,
) {
    val servers = serverStore.servers

    fun nodeEvents(server: Server): Flow<ServerEvent> = flow {
        val token = tokenStore.getToken(server.id) ?: return@flow
        emitAll(sse.events(server, token))
    }

    suspend fun login(server: Server, username: String, password: String, label: String): Result<Unit> {
        val result = api.login(server, username, password, label)
        if (result.isSuccess) {
            serverStore.save(server)
            tokenStore.setToken(server.id, result.getOrThrow())
        }
        return result.map {}
    }

    suspend fun updateServer(server: Server) = serverStore.update(server)

    suspend fun connect(
        server: Server, localNode: String, remoteNode: String,
        mode: ConnectMode, permanent: Boolean,
    ): Result<Unit> {
        val token = tokenStore.getToken(server.id) ?: return Result.failure(Exception("Not authenticated"))
        return api.connect(server, token, localNode, remoteNode, mode, permanent)
    }

    suspend fun disconnect(
        server: Server, localNode: String, remoteNode: String, permanent: Boolean,
    ): Result<Unit> {
        val token = tokenStore.getToken(server.id) ?: return Result.failure(Exception("Not authenticated"))
        return api.disconnect(server, token, localNode, remoteNode, permanent)
    }

    suspend fun sendDtmf(server: Server, node: String, digits: String): Result<Unit> {
        val token = tokenStore.getToken(server.id) ?: return Result.failure(Exception("Not authenticated"))
        return api.sendDtmf(server, token, node, digits)
    }

    suspend fun getFavoriteStatuses(server: Server): Result<List<FavoriteNodeStatus>> {
        val token = tokenStore.getToken(server.id) ?: return Result.failure(Exception("Not authenticated"))
        return api.getFavoriteStatuses(server, token)
    }

    suspend fun deleteServer(server: Server): Result<Unit> = runCatching {
        val token = tokenStore.getToken(server.id)
        if (token != null) {
            api.revokeToken(server, token)
            tokenStore.deleteToken(server.id)
        }
        serverStore.delete(server.id)
    }
}
```

- [ ] **Step 2: Implement `AppModule.kt`**

```kotlin
package com.nodewatch.app.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideOkHttpClient(): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(HttpLoggingInterceptor().apply {
            level = HttpLoggingInterceptor.Level.BASIC
        })
        .build()
}
```

- [ ] **Step 3: Build to verify DI wiring**

```bash
cd android && ./gradlew :app:assembleDebug
# Expected: BUILD SUCCESSFUL
```

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/kotlin/com/nodewatch/app/data/repository/ \
        android/app/src/main/kotlin/com/nodewatch/app/di/
git commit -m "feat: add NodewatchRepository and Hilt AppModule"
```

---

## Phase 6 — Navigation + Theme

### Task 9: Theme and NavGraph

**Files:**
- Create: `android/app/src/main/kotlin/com/nodewatch/app/ui/theme/Theme.kt`
- Create: `android/app/src/main/kotlin/com/nodewatch/app/NavGraph.kt`
- Modify: `android/app/src/main/kotlin/com/nodewatch/app/MainActivity.kt`

- [ ] **Step 1: Create `Theme.kt`**

```kotlin
package com.nodewatch.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val DarkColors = darkColorScheme(
    primary = Color(0xFF4CAF50),
    onPrimary = Color.Black,
    secondary = Color(0xFF81C784),
    surface = Color(0xFF1E1E1E),
    background = Color(0xFF121212),
)

@Composable
fun NodewatchTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = DarkColors, content = content)
}
```

- [ ] **Step 2: Create `NavGraph.kt`**

```kotlin
package com.nodewatch.app

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.nodewatch.app.ui.screens.*

sealed class Route(val path: String) {
    object ServerList : Route("servers")
    object AddServer  : Route("servers/add")
    data class EditServer(val id: String = "{serverId}") : Route("servers/{serverId}/edit")
    data class Dashboard(val id: String = "{serverId}") : Route("servers/{serverId}/dashboard")
    data class NodeDetail(val serverId: String = "{serverId}", val node: String = "{node}") :
        Route("servers/{serverId}/nodes/{node}")
    data class ServerSettings(val id: String = "{serverId}") : Route("servers/{serverId}/settings")
    data class Favorites(val id: String = "{serverId}") : Route("servers/{serverId}/favorites")
}

@Composable
fun NodewatchNavGraph(navController: NavHostController = rememberNavController()) {
    NavHost(navController, startDestination = Route.ServerList.path) {
        composable(Route.ServerList.path) {
            ServerListScreen(
                onAddServer = { navController.navigate(Route.AddServer.path) },
                onServerSelected = { id -> navController.navigate("servers/$id/dashboard") },
                onEditServer = { id -> navController.navigate("servers/$id/edit") },
            )
        }
        composable(Route.AddServer.path) {
            AddServerScreen(onDone = { navController.popBackStack() })
        }
        composable(
            Route.EditServer().path,
            arguments = listOf(navArgument("serverId") { type = NavType.StringType }),
        ) { back ->
            val id = back.arguments!!.getString("serverId")!!
            AddServerScreen(serverId = id, onDone = { navController.popBackStack() })
        }
        composable(
            Route.Dashboard().path,
            arguments = listOf(navArgument("serverId") { type = NavType.StringType }),
        ) { back ->
            val id = back.arguments!!.getString("serverId")!!
            DashboardScreen(
                serverId = id,
                onNodeTap = { node -> navController.navigate("servers/$id/nodes/$node") },
                onFavoritesTap = { navController.navigate("servers/$id/favorites") },
                onSettingsTap = { navController.navigate("servers/$id/settings") },
            )
        }
        composable(
            Route.NodeDetail().path,
            arguments = listOf(
                navArgument("serverId") { type = NavType.StringType },
                navArgument("node") { type = NavType.StringType },
            ),
        ) { back ->
            val serverId = back.arguments!!.getString("serverId")!!
            val node = back.arguments!!.getString("node")!!
            NodeDetailScreen(serverId = serverId, node = node, onBack = { navController.popBackStack() })
        }
        composable(
            Route.Favorites().path,
            arguments = listOf(navArgument("serverId") { type = NavType.StringType }),
        ) { back ->
            val id = back.arguments!!.getString("serverId")!!
            FavoritesScreen(serverId = id, onBack = { navController.popBackStack() })
        }
        composable(
            Route.ServerSettings().path,
            arguments = listOf(navArgument("serverId") { type = NavType.StringType }),
        ) { back ->
            val id = back.arguments!!.getString("serverId")!!
            ServerSettingsScreen(serverId = id, onDeleted = { navController.navigate(Route.ServerList.path) { popUpTo(0) } })
        }
    }
}
```

- [ ] **Step 3: Update `MainActivity.kt` to wire NavGraph**

```kotlin
setContent {
    NodewatchTheme {
        NodewatchNavGraph()
    }
}
```

- [ ] **Step 4: Create empty screen stubs** so NavGraph compiles

Create each file with a minimal `@Composable fun XScreen(...)` body showing a `Text("TODO")`. Files:
- `ui/screens/ServerListScreen.kt`
- `ui/screens/AddServerScreen.kt`
- `ui/screens/DashboardScreen.kt`
- `ui/screens/NodeDetailScreen.kt`
- `ui/screens/FavoritesScreen.kt`
- `ui/screens/ServerSettingsScreen.kt`

Example stub (repeat for each):
```kotlin
package com.nodewatch.app.ui.screens

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable

@Composable
fun ServerListScreen(
    onAddServer: () -> Unit,
    onServerSelected: (String) -> Unit,
    onEditServer: (String) -> Unit,
) { Text("Server List — TODO") }
```

- [ ] **Step 5: Build**

```bash
cd android && ./gradlew :app:assembleDebug
# Expected: BUILD SUCCESSFUL
```

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/kotlin/com/nodewatch/app/
git commit -m "feat: add theme, NavGraph, and screen stubs"
```

---

## Phase 7 — Server Management Screens

### Task 10: Server List screen

**Files:**
- Create: `android/app/src/main/kotlin/com/nodewatch/app/ui/screens/ServerListViewModel.kt`
- Modify: `android/app/src/main/kotlin/com/nodewatch/app/ui/screens/ServerListScreen.kt`

- [ ] **Step 1: Implement `ServerListViewModel.kt`**

```kotlin
package com.nodewatch.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nodewatch.app.data.model.Server
import com.nodewatch.app.data.repository.NodewatchRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class ServerListViewModel @Inject constructor(
    private val repo: NodewatchRepository,
) : ViewModel() {

    val servers = repo.servers.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun delete(server: Server) = viewModelScope.launch { repo.deleteServer(server) }
}
```

- [ ] **Step 2: Implement `ServerListScreen.kt`**

```kotlin
package com.nodewatch.app.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.nodewatch.app.data.model.Server

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ServerListScreen(
    onAddServer: () -> Unit,
    onServerSelected: (String) -> Unit,
    onEditServer: (String) -> Unit,
    vm: ServerListViewModel = hiltViewModel(),
) {
    val servers by vm.servers.collectAsState()
    var menuServer by remember { mutableStateOf<Server?>(null) }

    Scaffold(
        topBar = { TopAppBar(title = { Text("nodewatch") }) },
        floatingActionButton = { FloatingActionButton(onClick = onAddServer) { Icon(Icons.Default.Add, "Add server") } },
    ) { padding ->
        if (servers.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("No servers added", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    Button(onClick = onAddServer) { Text("Add your first server") }
                }
            }
        } else {
            LazyColumn(modifier = Modifier.padding(padding)) {
                items(servers, key = { it.id }) { server ->
                    ListItem(
                        headlineContent = { Text(server.name) },
                        supportingContent = { Text("${server.host}:${server.port}") },
                        modifier = Modifier.combinedClickable(
                            onClick = { onServerSelected(server.id) },
                            onLongClick = { menuServer = server },
                        ),
                    )
                    HorizontalDivider()
                }
            }
        }
    }

    menuServer?.let { server ->
        DropdownMenu(expanded = true, onDismissRequest = { menuServer = null }) {
            DropdownMenuItem(
                text = { Text("Edit") },
                leadingIcon = { Icon(Icons.Default.Edit, null) },
                onClick = { menuServer = null; onEditServer(server.id) },
            )
            DropdownMenuItem(
                text = { Text("Delete") },
                leadingIcon = { Icon(Icons.Default.Delete, null) },
                onClick = { menuServer = null; vm.delete(server) },
            )
        }
    }
}
```

- [ ] **Step 3: Build and run on emulator**

```bash
cd android && ./gradlew :app:installDebug
# Open app on emulator — expect Server List with empty state and FAB
```

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/kotlin/com/nodewatch/app/ui/screens/ServerListViewModel.kt \
        android/app/src/main/kotlin/com/nodewatch/app/ui/screens/ServerListScreen.kt
git commit -m "feat: Server List screen with empty state and long-press menu"
```

---

### Task 11: Add/Edit Server screen (login → token exchange)

**Files:**
- Create: `android/app/src/main/kotlin/com/nodewatch/app/ui/screens/AddServerViewModel.kt`
- Modify: `android/app/src/main/kotlin/com/nodewatch/app/ui/screens/AddServerScreen.kt`

- [ ] **Step 1: Implement `AddServerViewModel.kt`**

```kotlin
package com.nodewatch.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nodewatch.app.data.model.Server
import com.nodewatch.app.data.repository.NodewatchRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

data class AddServerUiState(
    val name: String = "",
    val host: String = "",
    val port: String = "8080",
    val username: String = "admin",
    val password: String = "",
    val loading: Boolean = false,
    val error: String? = null,
    val done: Boolean = false,
)

@HiltViewModel
class AddServerViewModel @Inject constructor(
    private val repo: NodewatchRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(AddServerUiState())
    val state = _state.asStateFlow()

    fun update(transform: AddServerUiState.() -> AddServerUiState) {
        _state.value = _state.value.transform()
    }

    fun loadServer(id: String) = viewModelScope.launch {
        val server = repo.servers.first().find { it.id == id } ?: return@launch
        _state.value = _state.value.copy(name = server.name, host = server.host, port = server.port.toString())
    }

    fun save(existingId: String? = null) = viewModelScope.launch {
        val s = _state.value
        val port = s.port.toIntOrNull() ?: run { _state.value = s.copy(error = "Invalid port"); return@launch }
        _state.value = s.copy(loading = true, error = null)
        val server = Server(id = existingId ?: java.util.UUID.randomUUID().toString(), name = s.name.ifBlank { s.host }, host = s.host, port = port)
        val result = if (existingId != null) {
            repo.updateServer(server); Result.success(Unit)
        } else {
            repo.login(server, s.username, s.password, android.os.Build.MODEL)
        }
        _state.value = if (result.isSuccess) s.copy(loading = false, done = true)
        else s.copy(loading = false, error = result.exceptionOrNull()?.message ?: "Login failed")
    }
}
```

- [ ] **Step 2: Implement `AddServerScreen.kt`**

```kotlin
package com.nodewatch.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

@Composable
fun AddServerScreen(
    serverId: String? = null,
    onDone: () -> Unit,
    vm: AddServerViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsState()

    LaunchedEffect(serverId) { if (serverId != null) vm.loadServer(serverId) }
    LaunchedEffect(state.done) { if (state.done) onDone() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (serverId == null) "Add Server" else "Edit Server") },
                navigationIcon = { IconButton(onDone) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        }
    ) { padding ->
        Column(Modifier.padding(padding).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(value = state.name, onValueChange = { vm.update { copy(name = it) } }, label = { Text("Name (optional)") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = state.host, onValueChange = { vm.update { copy(host = it) } }, label = { Text("Host / IP") }, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
            OutlinedTextField(value = state.port, onValueChange = { vm.update { copy(port = it) } }, label = { Text("Port") }, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
            if (serverId == null) {
                OutlinedTextField(value = state.username, onValueChange = { vm.update { copy(username = it) } }, label = { Text("Username") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = state.password, onValueChange = { vm.update { copy(password = it) } }, label = { Text("Password") }, modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation())
            }
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(
                onClick = { vm.save(serverId) },
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.loading && state.host.isNotBlank(),
            ) {
                if (state.loading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else Text(if (serverId == null) "Connect" else "Save")
            }
        }
    }
}
```

- [ ] **Step 3: Build and test on emulator**

```bash
cd android && ./gradlew :app:installDebug
# Tap FAB on Server List → Add Server screen appears
# Fill in LAN IP + credentials → tap Connect
# Expected: navigates back to Server List, server appears in list
```

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/kotlin/com/nodewatch/app/ui/screens/AddServerViewModel.kt \
        android/app/src/main/kotlin/com/nodewatch/app/ui/screens/AddServerScreen.kt
git commit -m "feat: Add/Edit Server screen with login and token exchange"
```

---

## Phase 8 — Node Monitoring

### Task 12: Dashboard screen (live SSE)

**Files:**
- Create: `android/app/src/main/kotlin/com/nodewatch/app/ui/screens/DashboardViewModel.kt`
- Create: `android/app/src/main/kotlin/com/nodewatch/app/ui/components/NodeCard.kt`
- Modify: `android/app/src/main/kotlin/com/nodewatch/app/ui/screens/DashboardScreen.kt`

- [ ] **Step 1: Implement `DashboardViewModel.kt`**

```kotlin
package com.nodewatch.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nodewatch.app.data.model.NodeStatus
import com.nodewatch.app.data.model.Server
import com.nodewatch.app.data.model.ServerEvent
import com.nodewatch.app.data.repository.NodewatchRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

data class DashboardUiState(
    val server: Server? = null,
    val nodes: Map<String, NodeStatus> = emptyMap(),
    val sseConnected: Boolean = false,
    val error: String? = null,
)

@HiltViewModel
class DashboardViewModel @Inject constructor(
    private val repo: NodewatchRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(DashboardUiState())
    val state = _state.asStateFlow()

    fun init(serverId: String) = viewModelScope.launch {
        val server = repo.servers.first().find { it.id == serverId } ?: return@launch
        _state.update { it.copy(server = server) }
        repo.nodeEvents(server)
            .onStart { _state.update { it.copy(sseConnected = true) } }
            .catch { e -> _state.update { it.copy(sseConnected = false, error = e.message) } }
            .collect { event ->
                when (event) {
                    is ServerEvent.NodeStatusEvent -> _state.update { s ->
                        s.copy(nodes = s.nodes + (event.status.node to event.status))
                    }
                    is ServerEvent.NodeTimesEvent -> _state.update { s ->
                        val current = s.nodes[event.times.node] ?: return@update s
                        val timingMap = event.times.connections.associateBy { it.node }
                        val updated = current.copy(connections = current.connections.map { conn ->
                            val t = timingMap[conn.node] ?: return@map conn
                            conn.copy(elapsed = t.elapsed, lastKeyed = t.lastKeyed)
                        })
                        s.copy(nodes = s.nodes + (event.times.node to updated))
                    }
                    is ServerEvent.NodeErrorEvent -> _state.update { it.copy(error = event.error) }
                    else -> {}
                }
            }
    }
}
```

- [ ] **Step 2: Implement `NodeCard.kt`**

```kotlin
package com.nodewatch.app.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.nodewatch.app.data.model.NodeStatus

@Composable
fun NodeCard(status: NodeStatus, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).clickable(onClick = onClick)) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Node ${status.node}", style = MaterialTheme.typography.titleMedium)
                Text("${status.connections.size} link(s)", style = MaterialTheme.typography.bodySmall)
            }
            KeyedIndicator("COS", status.cosKeyed)
            Spacer(Modifier.width(8.dp))
            KeyedIndicator("TX", status.txKeyed)
        }
    }
}

@Composable
private fun KeyedIndicator(label: String, active: Boolean) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Surface(
            shape = MaterialTheme.shapes.small,
            color = if (active) Color(0xFF4CAF50) else Color(0xFF424242),
            modifier = Modifier.size(12.dp),
        ) {}
        Text(label, style = MaterialTheme.typography.labelSmall)
    }
}
```

- [ ] **Step 3: Implement `DashboardScreen.kt`**

```kotlin
package com.nodewatch.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.nodewatch.app.ui.components.NodeCard
import kotlinx.coroutines.launch

@Composable
fun DashboardScreen(
    serverId: String,
    onNodeTap: (String) -> Unit,
    onFavoritesTap: () -> Unit,
    onSettingsTap: () -> Unit,
    vm: DashboardViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    LaunchedEffect(serverId) { vm.init(serverId) }
    LaunchedEffect(state.error) { state.error?.let { snackbarHostState.showSnackbar(it) } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.server?.name ?: "Dashboard") },
                actions = {
                    IconButton(onFavoritesTap) { Icon(Icons.Default.Favorite, "Favorites") }
                    IconButton(onSettingsTap) { Icon(Icons.Default.Settings, "Settings") }
                }
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        val nodes = state.nodes.values.toList()
        if (nodes.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    if (!state.sseConnected) CircularProgressIndicator()
                    Text(if (state.sseConnected) "No nodes configured" else "Connecting…", Modifier.padding(top = 8.dp))
                }
            }
        } else {
            LazyColumn(Modifier.padding(padding).padding(vertical = 8.dp)) {
                items(nodes, key = { it.node }) { status ->
                    NodeCard(status = status, onClick = { onNodeTap(status.node) })
                }
            }
        }
    }
}
```

- [ ] **Step 4: Test on device/emulator with running nodewatch server**

```bash
# Start nodewatch on LAN machine
# Install app, add that server, verify live keyed-state updates
cd android && ./gradlew :app:installDebug
```

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/kotlin/com/nodewatch/app/ui/screens/DashboardViewModel.kt \
        android/app/src/main/kotlin/com/nodewatch/app/ui/components/NodeCard.kt \
        android/app/src/main/kotlin/com/nodewatch/app/ui/screens/DashboardScreen.kt
git commit -m "feat: Dashboard screen with live SSE node status updates"
```

---

### Task 13: Node Detail screen + Connect/Disconnect/DTMF

**Files:**
- Create: `android/app/src/main/kotlin/com/nodewatch/app/ui/screens/NodeDetailViewModel.kt`
- Create: `android/app/src/main/kotlin/com/nodewatch/app/ui/components/ConnectionRow.kt`
- Create: `android/app/src/main/kotlin/com/nodewatch/app/ui/components/ConnectSheet.kt`
- Create: `android/app/src/main/kotlin/com/nodewatch/app/ui/components/DtmfDialpad.kt`
- Modify: `android/app/src/main/kotlin/com/nodewatch/app/ui/screens/NodeDetailScreen.kt`

- [ ] **Step 1: Implement `NodeDetailViewModel.kt`**

```kotlin
package com.nodewatch.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nodewatch.app.data.model.NodeStatus
import com.nodewatch.app.data.model.Server
import com.nodewatch.app.data.model.ServerEvent
import com.nodewatch.app.data.remote.ConnectMode
import com.nodewatch.app.data.repository.NodewatchRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

data class NodeDetailUiState(
    val server: Server? = null,
    val status: NodeStatus? = null,
    val actionError: String? = null,
)

@HiltViewModel
class NodeDetailViewModel @Inject constructor(
    private val repo: NodewatchRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(NodeDetailUiState())
    val state = _state.asStateFlow()

    fun init(serverId: String, node: String) = viewModelScope.launch {
        val server = repo.servers.first().find { it.id == serverId } ?: return@launch
        _state.update { it.copy(server = server) }
        repo.nodeEvents(server)
            .filterIsInstance<ServerEvent.NodeStatusEvent>()
            .filter { it.status.node == node }
            .collect { event -> _state.update { it.copy(status = event.status) } }
    }

    fun connect(remoteNode: String, mode: ConnectMode, permanent: Boolean) = viewModelScope.launch {
        val s = _state.value
        val server = s.server ?: return@launch
        val localNode = s.status?.node ?: return@launch
        repo.connect(server, localNode, remoteNode, mode, permanent)
            .onFailure { e -> _state.update { it.copy(actionError = e.message) } }
    }

    fun disconnect(remoteNode: String, permanent: Boolean) = viewModelScope.launch {
        val s = _state.value
        val server = s.server ?: return@launch
        val localNode = s.status?.node ?: return@launch
        repo.disconnect(server, localNode, remoteNode, permanent)
            .onFailure { e -> _state.update { it.copy(actionError = e.message) } }
    }

    fun sendDtmf(digits: String) = viewModelScope.launch {
        val s = _state.value
        val server = s.server ?: return@launch
        val node = s.status?.node ?: return@launch
        repo.sendDtmf(server, node, digits)
            .onFailure { e -> _state.update { it.copy(actionError = e.message) } }
    }

    fun clearError() = _state.update { it.copy(actionError = null) }
}
```

- [ ] **Step 2: Implement `ConnectionRow.kt`**

```kotlin
package com.nodewatch.app.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LinkOff
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.nodewatch.app.data.model.Connection

@Composable
fun ConnectionRow(conn: Connection, onDisconnect: () -> Unit) {
    ListItem(
        headlineContent = { Text("Node ${conn.node}") },
        supportingContent = {
            Column {
                Text("${conn.info.ifBlank { conn.ip }} • ${conn.direction} • ${modeLabel(conn.mode)}")
                Text("${conn.elapsed}s connected${if (conn.lastKeyed >= 0) " • keyed ${conn.lastKeyed}s ago" else ""}")
            }
        },
        leadingContent = {
            Surface(shape = MaterialTheme.shapes.small, color = if (conn.keyed) Color(0xFF4CAF50) else Color(0xFF424242), modifier = Modifier.size(12.dp)) {}
        },
        trailingContent = {
            IconButton(onDisconnect) { Icon(Icons.Default.LinkOff, "Disconnect") }
        },
    )
}

private fun modeLabel(mode: String) = when (mode) {
    "T" -> "Transceive"
    "R" -> "Receive"
    "M" -> "Monitor"
    "C" -> "Connecting"
    else -> mode
}
```

- [ ] **Step 3: Implement `ConnectSheet.kt`**

```kotlin
package com.nodewatch.app.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.nodewatch.app.data.remote.ConnectMode

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectSheet(
    onDismiss: () -> Unit,
    onConnect: (remoteNode: String, mode: ConnectMode, permanent: Boolean) -> Unit,
) {
    var remoteNode by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf(ConnectMode.TRANSCEIVE) }
    var permanent by remember { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(16.dp).padding(bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Connect Node", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = remoteNode,
                onValueChange = { remoteNode = it },
                label = { Text("Remote Node #") },
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ConnectMode.entries.forEach { m ->
                    FilterChip(
                        selected = mode == m,
                        onClick = { mode = m },
                        label = { Text(when (m) { ConnectMode.TRANSCEIVE -> "Transceive"; ConnectMode.MONITOR -> "Monitor"; ConnectMode.LOCAL_MONITOR -> "Local Mon" }) },
                    )
                }
            }
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Switch(checked = permanent, onCheckedChange = { permanent = it })
                Spacer(Modifier.width(8.dp))
                Text("Permanent")
            }
            Button(
                onClick = { if (remoteNode.isNotBlank()) { onConnect(remoteNode, mode, permanent); onDismiss() } },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Connect") }
        }
    }
}
```

- [ ] **Step 4: Implement `DtmfDialpad.kt`**

```kotlin
package com.nodewatch.app.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

private val DTMF_KEYS = listOf(
    listOf("1", "2", "3"),
    listOf("4", "5", "6"),
    listOf("7", "8", "9"),
    listOf("*", "0", "#"),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DtmfDialpad(onDismiss: () -> Unit, onSend: (String) -> Unit) {
    var digits by remember { mutableStateOf("") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.padding(16.dp).padding(bottom = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("DTMF", style = MaterialTheme.typography.titleMedium)
            Text(digits.ifEmpty { "—" }, style = MaterialTheme.typography.headlineMedium)
            DTMF_KEYS.forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { key ->
                        FilledTonalButton(onClick = { digits += key }, modifier = Modifier.size(72.dp)) {
                            Text(key, style = MaterialTheme.typography.titleLarge)
                        }
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { digits = digits.dropLast(1) }, modifier = Modifier.weight(1f)) { Text("⌫") }
                Button(
                    onClick = { if (digits.isNotBlank()) { onSend(digits); onDismiss() } },
                    modifier = Modifier.weight(1f),
                ) { Text("Send") }
            }
        }
    }
}
```

- [ ] **Step 5: Implement `NodeDetailScreen.kt`**

```kotlin
package com.nodewatch.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Dialpad
import androidx.compose.material.icons.filled.Link
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.nodewatch.app.ui.components.ConnectSheet
import com.nodewatch.app.ui.components.ConnectionRow
import com.nodewatch.app.ui.components.DtmfDialpad

@Composable
fun NodeDetailScreen(
    serverId: String,
    node: String,
    onBack: () -> Unit,
    vm: NodeDetailViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    var showConnect by remember { mutableStateOf(false) }
    var showDtmf by remember { mutableStateOf(false) }

    LaunchedEffect(serverId, node) { vm.init(serverId, node) }
    LaunchedEffect(state.actionError) { state.actionError?.let { snackbarHostState.showSnackbar(it); vm.clearError() } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Node $node") },
                navigationIcon = { IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    IconButton({ showDtmf = true }) { Icon(Icons.Default.Dialpad, "DTMF") }
                    IconButton({ showConnect = true }) { Icon(Icons.Default.Link, "Connect") }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        val connections = state.status?.connections ?: emptyList()
        if (connections.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text("No links active")
            }
        } else {
            LazyColumn(Modifier.padding(padding)) {
                items(connections, key = { it.node }) { conn ->
                    ConnectionRow(conn = conn, onDisconnect = { vm.disconnect(conn.node, permanent = false) })
                    HorizontalDivider()
                }
            }
        }
    }

    if (showConnect) {
        ConnectSheet(
            onDismiss = { showConnect = false },
            onConnect = { remote, mode, perm -> vm.connect(remote, mode, perm) },
        )
    }
    if (showDtmf) {
        DtmfDialpad(onDismiss = { showDtmf = false }, onSend = vm::sendDtmf)
    }
}
```

- [ ] **Step 6: Build and test on device**

```bash
cd android && ./gradlew :app:installDebug
# Tap a node on Dashboard → Node Detail
# Verify connections list shows with disconnect buttons
# Tap Link icon → Connect sheet appears
# Tap Dialpad icon → DTMF pad appears
```

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/kotlin/com/nodewatch/app/ui/
git commit -m "feat: Node Detail screen with connect/disconnect/DTMF controls"
```

---

## Phase 9 — Favorites + Server Settings

### Task 14: Favorites screen

**Files:**
- Create: `android/app/src/main/kotlin/com/nodewatch/app/ui/screens/FavoritesViewModel.kt`
- Modify: `android/app/src/main/kotlin/com/nodewatch/app/ui/screens/FavoritesScreen.kt`

- [ ] **Step 1: Implement `FavoritesViewModel.kt`**

```kotlin
package com.nodewatch.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nodewatch.app.data.model.FavoriteNodeStatus
import com.nodewatch.app.data.repository.NodewatchRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class FavoritesViewModel @Inject constructor(private val repo: NodewatchRepository) : ViewModel() {

    private val _favorites = MutableStateFlow<List<FavoriteNodeStatus>>(emptyList())
    val favorites = _favorites.asStateFlow()
    private val _loading = MutableStateFlow(false)
    val loading = _loading.asStateFlow()

    fun init(serverId: String) = viewModelScope.launch {
        val server = repo.servers.first().find { it.id == serverId } ?: return@launch
        while (true) {
            _loading.value = true
            repo.getFavoriteStatuses(server).onSuccess { _favorites.value = it }
            _loading.value = false
            delay(30_000)
        }
    }
}
```

- [ ] **Step 2: Implement `FavoritesScreen.kt`**

```kotlin
package com.nodewatch.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

@Composable
fun FavoritesScreen(
    serverId: String,
    onBack: () -> Unit,
    vm: FavoritesViewModel = hiltViewModel(),
) {
    val favorites by vm.favorites.collectAsState()
    val loading by vm.loading.collectAsState()
    LaunchedEffect(serverId) { vm.init(serverId) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Favorites") },
                navigationIcon = { IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        }
    ) { padding ->
        LazyColumn(Modifier.padding(padding)) {
            if (loading && favorites.isEmpty()) {
                item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            }
            items(favorites, key = { it.node }) { fav ->
                ListItem(
                    headlineContent = { Text("Node ${fav.node}") },
                    supportingContent = { Text(fav.callsign) },
                    leadingContent = {
                        Surface(
                            shape = MaterialTheme.shapes.small,
                            color = if (fav.connected) Color(0xFF4CAF50) else Color(0xFF424242),
                            modifier = Modifier.size(12.dp),
                        ) {}
                    },
                )
                HorizontalDivider()
            }
        }
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/kotlin/com/nodewatch/app/ui/screens/FavoritesViewModel.kt \
        android/app/src/main/kotlin/com/nodewatch/app/ui/screens/FavoritesScreen.kt
git commit -m "feat: Favorites screen with 30s auto-refresh"
```

---

### Task 15: Server Settings screen

**Files:**
- Create: `android/app/src/main/kotlin/com/nodewatch/app/ui/screens/ServerSettingsViewModel.kt`
- Modify: `android/app/src/main/kotlin/com/nodewatch/app/ui/screens/ServerSettingsScreen.kt`

- [ ] **Step 1: Implement `ServerSettingsViewModel.kt`**

```kotlin
package com.nodewatch.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nodewatch.app.data.model.Server
import com.nodewatch.app.data.repository.NodewatchRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ServerSettingsUiState(
    val server: Server? = null,
    val name: String = "",
    val deleted: Boolean = false,
    val error: String? = null,
)

@HiltViewModel
class ServerSettingsViewModel @Inject constructor(private val repo: NodewatchRepository) : ViewModel() {

    private val _state = MutableStateFlow(ServerSettingsUiState())
    val state = _state.asStateFlow()

    fun init(serverId: String) = viewModelScope.launch {
        val server = repo.servers.first().find { it.id == serverId } ?: return@launch
        _state.update { it.copy(server = server, name = server.name) }
    }

    fun saveName() = viewModelScope.launch {
        val server = _state.value.server ?: return@launch
        repo.updateServer(server.copy(name = _state.value.name))
    }

    fun updateName(name: String) = _state.update { it.copy(name = name) }

    fun delete() = viewModelScope.launch {
        val server = _state.value.server ?: return@launch
        repo.deleteServer(server)
            .onSuccess { _state.update { it.copy(deleted = true) } }
            .onFailure { e -> _state.update { it.copy(error = e.message) } }
    }
}
```

- [ ] **Step 2: Implement `ServerSettingsScreen.kt`**

```kotlin
package com.nodewatch.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

@Composable
fun ServerSettingsScreen(
    serverId: String,
    onDeleted: () -> Unit,
    vm: ServerSettingsViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsState()
    var confirmDelete by remember { mutableStateOf(false) }

    LaunchedEffect(serverId) { vm.init(serverId) }
    LaunchedEffect(state.deleted) { if (state.deleted) onDeleted() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Server Settings") },
                navigationIcon = { IconButton(onClick = {}) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        }
    ) { padding ->
        Column(Modifier.padding(padding).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("${state.server?.host}:${state.server?.port}", style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(
                value = state.name,
                onValueChange = vm::updateName,
                label = { Text("Display Name") },
                modifier = Modifier.fillMaxWidth(),
            )
            Button(onClick = vm::saveName, modifier = Modifier.fillMaxWidth()) { Text("Save Name") }
            Spacer(Modifier.height(16.dp))
            OutlinedButton(
                onClick = { confirmDelete = true },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
            ) { Text("Remove Server") }
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Remove server?") },
            text = { Text("This will revoke the access token and remove the server from this app.") },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; vm.delete() }) { Text("Remove", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text("Cancel") }
            },
        )
    }
}
```

- [ ] **Step 3: Build final APK**

```bash
cd android && ./gradlew :app:assembleDebug
# Expected: BUILD SUCCESSFUL
```

- [ ] **Step 4: End-to-end verification**

1. Start nodewatch: `node --experimental-strip-types server.ts` in supermon repo
2. Install APK on Android device on same LAN
3. Add server → fill host + credentials → Connect → server appears in list
4. Tap server → Dashboard loads → live COS/TX indicators update in real time
5. Tap a node → Node Detail shows connections
6. Tap Link icon → Connect sheet → enter a remote node number → Connect
7. Verify in nodewatch web UI that the node is now linked
8. Swipe or tap disconnect icon on a connection → verify unlinked in web UI
9. Tap Dialpad → send DTMF digits
10. Tap Favorites → list shows favorite nodes' status
11. Tap Settings → rename server → save
12. Tap Remove Server → confirm → navigated back to Server List, server gone
13. Reopen app → Server List is empty (token revoked, server removed)

- [ ] **Step 5: Final commit**

```bash
git add android/app/src/main/kotlin/com/nodewatch/app/ui/screens/ServerSettingsViewModel.kt \
        android/app/src/main/kotlin/com/nodewatch/app/ui/screens/ServerSettingsScreen.kt
git commit -m "feat: Server Settings screen with rename and delete (token revocation)"
```
