package com.nodewatch.app.data.model

import java.util.UUID
import kotlinx.serialization.Serializable

@Serializable
data class Server(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val host: String,
    val port: Int = 8080,
) {
    val baseUrl: String get() = "http://$host:$port"
}
