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
