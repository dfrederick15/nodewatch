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
    val info: String = "",
    val status: String = "offline",
    @SerialName("connection_count") val connectionCount: Int = 0,
    val keyed: Boolean = false,
) {
    val isConnected: Boolean get() = status == "online"
}

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
