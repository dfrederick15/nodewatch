package com.nodewatch.app.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun AddServerScreen(
    serverId: String? = null,
    onDone: () -> Unit,
    vm: AddServerViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsState()

    LaunchedEffect(serverId) { if (serverId != null) vm.loadServer(serverId) }
    LaunchedEffect(state.done) { if (state.done) onDone() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (serverId == null) "Add Server" else "Edit Server") },
                navigationIcon = { IconButton(onDone) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        }
    ) { padding ->
        Column(Modifier.padding(padding).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(value = state.name, onValueChange = { vm.update { copy(name = it) } }, label = { Text("Name (optional)") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = state.host, onValueChange = { vm.update { copy(host = it) } }, label = { Text("Host / IP") }, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
            OutlinedTextField(value = state.port, onValueChange = { vm.update { copy(port = it) } }, label = { Text("Port") }, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
            if (serverId == null) {
                OutlinedTextField(value = state.username, onValueChange = { vm.update { copy(username = it) } }, label = { Text("Username") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = state.password, onValueChange = { vm.update { copy(password = it) } }, label = { Text("Password") }, modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation())
            }
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(
                onClick = { vm.save(serverId) },
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.loading && state.host.isNotBlank(),
            ) {
                if (state.loading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else Text(if (serverId == null) "Connect" else "Save")
            }
        }
    }
}
