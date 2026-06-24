package com.nodewatch.app.data.remote

import com.nodewatch.app.data.model.FavoriteNodeStatus
import com.nodewatch.app.data.model.Server
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
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

    suspend fun connect(
        server: Server, token: String,
        localNode: String, remoteNode: String,
        mode: ConnectMode, permanent: Boolean,
    ): Result<Unit> = runCatching {
        @Serializable data class Body(
            @SerialName("local_node") val localNode: String,
            @SerialName("remote_node") val remoteNode: String,
            val mode: String,
            val permanent: String,
        )
        val modeStr = when (mode) {
            ConnectMode.TRANSCEIVE    -> "connect"
            ConnectMode.MONITOR       -> "monitor"
            ConnectMode.LOCAL_MONITOR -> "localmonitor"
        }
        val resp = post("${server.baseUrl}/api/connect", token, json.encodeToString(Body(localNode, remoteNode, modeStr, permanent.toString())))
        if (!resp.isSuccessful) error("HTTP ${resp.code}: ${resp.body?.string()}")
    }

    suspend fun disconnect(
        server: Server, token: String,
        localNode: String, remoteNode: String, permanent: Boolean,
    ): Result<Unit> = runCatching {
        @Serializable data class Body(
            @SerialName("local_node") val localNode: String,
            @SerialName("remote_node") val remoteNode: String,
            val permanent: String,
        )
        val resp = post("${server.baseUrl}/api/disconnect", token, json.encodeToString(Body(localNode, remoteNode, permanent.toString())))
        if (!resp.isSuccessful) error("HTTP ${resp.code}: ${resp.body?.string()}")
    }

    suspend fun sendDtmf(server: Server, token: String, node: String, digits: String): Result<Unit> = runCatching {
        @Serializable data class Body(@SerialName("local_node") val localNode: String, val digits: String)
        val resp = post("${server.baseUrl}/api/dtmf", token, json.encodeToString(Body(node, digits)))
        if (!resp.isSuccessful) error("HTTP ${resp.code}: ${resp.body?.string()}")
    }

    suspend fun getFavoriteStatuses(server: Server, token: String): Result<List<FavoriteNodeStatus>> = runCatching {
        val resp = get("${server.baseUrl}/api/favorites/status", token)
        if (!resp.isSuccessful) error("HTTP ${resp.code}")
        json.decodeFromString(resp.body!!.string())
    }

    suspend fun revokeToken(server: Server, token: String): Result<Unit> = runCatching {
        val resp = delete("${server.baseUrl}/api/token", token)
        if (!resp.isSuccessful) error("HTTP ${resp.code}")
    }
}
