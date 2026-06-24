package com.nodewatch.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nodewatch.app.data.model.Server
import com.nodewatch.app.data.repository.NodewatchRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

data class AddServerUiState(
    val name: String = "",
    val host: String = "",
    val port: String = "8080",
    val username: String = "admin",
    val password: String = "",
    val loading: Boolean = false,
    val error: String? = null,
    val done: Boolean = false,
)

@HiltViewModel
class AddServerViewModel @Inject constructor(
    private val repo: NodewatchRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(AddServerUiState())
    val state = _state.asStateFlow()

    fun update(transform: AddServerUiState.() -> AddServerUiState) {
        _state.value = _state.value.transform()
    }

    fun loadServer(id: String) = viewModelScope.launch {
        val server = repo.servers.first().find { it.id == id } ?: return@launch
        _state.value = _state.value.copy(name = server.name, host = server.host, port = server.port.toString())
    }

    fun save(existingId: String? = null) = viewModelScope.launch {
        val s = _state.value
        val port = s.port.toIntOrNull() ?: run { _state.value = s.copy(error = "Invalid port"); return@launch }
        _state.value = s.copy(loading = true, error = null)
        val server = Server(id = existingId ?: java.util.UUID.randomUUID().toString(), name = s.name.ifBlank { s.host }, host = s.host, port = port)
        val result = if (existingId != null) {
            repo.updateServer(server); Result.success(Unit)
        } else {
            repo.login(server, s.username, s.password, android.os.Build.MODEL)
        }
        _state.value = if (result.isSuccess) s.copy(loading = false, done = true)
        else s.copy(loading = false, error = result.exceptionOrNull()?.message ?: "Login failed")
    }
}
