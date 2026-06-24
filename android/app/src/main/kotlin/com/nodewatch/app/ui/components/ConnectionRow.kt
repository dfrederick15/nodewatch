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
