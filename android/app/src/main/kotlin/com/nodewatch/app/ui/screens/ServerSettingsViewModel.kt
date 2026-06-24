package com.nodewatch.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nodewatch.app.data.model.Server
import com.nodewatch.app.data.repository.NodewatchRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ServerSettingsUiState(
    val server: Server? = null,
    val name: String = "",
    val deleted: Boolean = false,
    val error: String? = null,
)

@HiltViewModel
class ServerSettingsViewModel @Inject constructor(private val repo: NodewatchRepository) : ViewModel() {

    private val _state = MutableStateFlow(ServerSettingsUiState())
    val state = _state.asStateFlow()

    fun init(serverId: String) = viewModelScope.launch {
        val server = repo.servers.first().find { it.id == serverId } ?: return@launch
        _state.update { it.copy(server = server, name = server.name) }
    }

    fun saveName() = viewModelScope.launch {
        val server = _state.value.server ?: return@launch
        repo.updateServer(server.copy(name = _state.value.name))
    }

    fun updateName(name: String) = _state.update { it.copy(name = name) }

    fun delete() = viewModelScope.launch {
        val server = _state.value.server ?: return@launch
        repo.deleteServer(server)
            .onSuccess { _state.update { it.copy(deleted = true) } }
            .onFailure { e -> _state.update { it.copy(error = e.message) } }
    }
}
