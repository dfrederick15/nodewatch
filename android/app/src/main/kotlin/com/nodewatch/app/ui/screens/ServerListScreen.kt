package com.nodewatch.app.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.nodewatch.app.data.model.Server

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
fun ServerListScreen(
    onAddServer: () -> Unit,
    onServerSelected: (String) -> Unit,
    onEditServer: (String) -> Unit,
    vm: ServerListViewModel = hiltViewModel(),
) {
    val servers by vm.servers.collectAsState()
    var menuServer by remember { mutableStateOf<Server?>(null) }

    Scaffold(
        topBar = { TopAppBar(title = { Text("nodewatch") }) },
        floatingActionButton = { FloatingActionButton(onClick = onAddServer) { Icon(Icons.Default.Add, "Add server") } },
    ) { padding ->
        if (servers.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("No servers added", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    Button(onClick = onAddServer) { Text("Add your first server") }
                }
            }
        } else {
            LazyColumn(modifier = Modifier.padding(padding)) {
                items(servers, key = { it.id }) { server ->
                    ListItem(
                        headlineContent = { Text(server.name) },
                        supportingContent = { Text("${server.host}:${server.port}") },
                        modifier = Modifier.combinedClickable(
                            onClick = { onServerSelected(server.id) },
                            onLongClick = { menuServer = server },
                        ),
                    )
                    HorizontalDivider()
                }
            }
        }
    }

    menuServer?.let { server ->
        DropdownMenu(expanded = true, onDismissRequest = { menuServer = null }) {
            DropdownMenuItem(
                text = { Text("Edit") },
                leadingIcon = { Icon(Icons.Default.Edit, null) },
                onClick = { menuServer = null; onEditServer(server.id) },
            )
            DropdownMenuItem(
                text = { Text("Delete") },
                leadingIcon = { Icon(Icons.Default.Delete, null) },
                onClick = { menuServer = null; vm.delete(server) },
            )
        }
    }
}
