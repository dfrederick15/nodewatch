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
