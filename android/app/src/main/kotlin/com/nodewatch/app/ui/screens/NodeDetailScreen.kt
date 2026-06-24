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

@OptIn(ExperimentalMaterial3Api::class)
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
