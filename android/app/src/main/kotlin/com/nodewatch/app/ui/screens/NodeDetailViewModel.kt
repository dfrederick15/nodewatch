package com.nodewatch.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nodewatch.app.data.model.NodeStatus
import com.nodewatch.app.data.model.Server
import com.nodewatch.app.data.model.ServerEvent
import com.nodewatch.app.data.remote.ConnectMode
import com.nodewatch.app.data.repository.NodewatchRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

data class NodeDetailUiState(
    val server: Server? = null,
    val status: NodeStatus? = null,
    val actionError: String? = null,
)

@HiltViewModel
class NodeDetailViewModel @Inject constructor(
    private val repo: NodewatchRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(NodeDetailUiState())
    val state = _state.asStateFlow()

    fun init(serverId: String, node: String) = viewModelScope.launch {
        val server = repo.servers.first().find { it.id == serverId } ?: return@launch
        _state.update { it.copy(server = server) }
        repo.nodeEvents(server)
            .filterIsInstance<ServerEvent.NodeStatusEvent>()
            .filter { it.status.node == node }
            .collect { event -> _state.update { it.copy(status = event.status) } }
    }

    fun connect(remoteNode: String, mode: ConnectMode, permanent: Boolean) = viewModelScope.launch {
        val s = _state.value
        val server = s.server ?: return@launch
        val localNode = s.status?.node ?: return@launch
        repo.connect(server, localNode, remoteNode, mode, permanent)
            .onFailure { e -> _state.update { it.copy(actionError = e.message) } }
    }

    fun disconnect(remoteNode: String, permanent: Boolean) = viewModelScope.launch {
        val s = _state.value
        val server = s.server ?: return@launch
        val localNode = s.status?.node ?: return@launch
        repo.disconnect(server, localNode, remoteNode, permanent)
            .onFailure { e -> _state.update { it.copy(actionError = e.message) } }
    }

    fun sendDtmf(digits: String) = viewModelScope.launch {
        val s = _state.value
        val server = s.server ?: return@launch
        val node = s.status?.node ?: return@launch
        repo.sendDtmf(server, node, digits)
            .onFailure { e -> _state.update { it.copy(actionError = e.message) } }
    }

    fun clearError() = _state.update { it.copy(actionError = null) }
}
