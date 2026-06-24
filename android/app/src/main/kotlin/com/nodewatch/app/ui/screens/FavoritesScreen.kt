package com.nodewatch.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FavoritesScreen(
    serverId: String,
    onBack: () -> Unit,
    vm: FavoritesViewModel = hiltViewModel(),
) {
    val favorites by vm.favorites.collectAsState()
    val loading by vm.loading.collectAsState()
    LaunchedEffect(serverId) { vm.init(serverId) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Favorites") },
                navigationIcon = { IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        }
    ) { padding ->
        LazyColumn(Modifier.padding(padding)) {
            if (loading && favorites.isEmpty()) {
                item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            }
            items(favorites, key = { it.node }) { fav ->
                ListItem(
                    headlineContent = { Text("Node ${fav.node}") },
                    supportingContent = { Text(fav.info) },
                    leadingContent = {
                        Surface(
                            shape = MaterialTheme.shapes.small,
                            color = if (fav.isConnected) Color(0xFF4CAF50) else Color(0xFF424242),
                            modifier = Modifier.size(12.dp),
                        ) {}
                    },
                )
                HorizontalDivider()
            }
        }
    }
}
