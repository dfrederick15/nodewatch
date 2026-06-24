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
