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
