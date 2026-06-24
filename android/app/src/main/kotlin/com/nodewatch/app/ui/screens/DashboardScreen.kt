package com.nodewatch.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.nodewatch.app.ui.components.NodeCard

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    serverId: String,
    onNodeTap: (String) -> Unit,
    onFavoritesTap: () -> Unit,
    onSettingsTap: () -> Unit,
    vm: DashboardViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    LaunchedEffect(serverId) { vm.init(serverId) }
    LaunchedEffect(state.error) { state.error?.let { snackbarHostState.showSnackbar(it) } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.server?.name ?: "Dashboard") },
                actions = {
                    IconButton(onFavoritesTap) { Icon(Icons.Default.Favorite, "Favorites") }
                    IconButton(onSettingsTap) { Icon(Icons.Default.Settings, "Settings") }
                }
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        val nodes = state.nodes.values.toList()
        if (nodes.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    if (!state.sseConnected) CircularProgressIndicator()
                    Text(if (state.sseConnected) "No nodes configured" else "Connecting…", Modifier.padding(top = 8.dp))
                }
            }
        } else {
            LazyColumn(Modifier.padding(padding).padding(vertical = 8.dp)) {
                items(nodes, key = { it.node }) { status ->
                    NodeCard(status = status, onClick = { onNodeTap(status.node) })
                }
            }
        }
    }
}
