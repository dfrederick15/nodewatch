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
