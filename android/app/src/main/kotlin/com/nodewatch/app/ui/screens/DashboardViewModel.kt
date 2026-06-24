package com.nodewatch.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nodewatch.app.data.model.NodeStatus
import com.nodewatch.app.data.model.Server
import com.nodewatch.app.data.model.ServerEvent
import com.nodewatch.app.data.repository.NodewatchRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

data class DashboardUiState(
    val server: Server? = null,
    val nodes: Map<String, NodeStatus> = emptyMap(),
    val sseConnected: Boolean = false,
    val error: String? = null,
)

@HiltViewModel
class DashboardViewModel @Inject constructor(
    private val repo: NodewatchRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(DashboardUiState())
    val state = _state.asStateFlow()

    fun init(serverId: String) = viewModelScope.launch {
        val server = repo.servers.first().find { it.id == serverId } ?: return@launch
        _state.update { it.copy(server = server) }
        repo.nodeEvents(server)
            .onStart { _state.update { it.copy(sseConnected = true) } }
            .catch { e -> _state.update { it.copy(sseConnected = false, error = e.message) } }
            .collect { event ->
                when (event) {
                    is ServerEvent.NodeStatusEvent -> _state.update { s ->
                        s.copy(nodes = s.nodes + (event.status.node to event.status))
                    }
                    is ServerEvent.NodeTimesEvent -> _state.update { s ->
                        val current = s.nodes[event.times.node] ?: return@update s
                        val timingMap = event.times.connections.associateBy { it.node }
                        val updated = current.copy(connections = current.connections.map { conn ->
                            val t = timingMap[conn.node] ?: return@map conn
                            conn.copy(elapsed = t.elapsed, lastKeyed = t.lastKeyed)
                        })
                        s.copy(nodes = s.nodes + (event.times.node to updated))
                    }
                    is ServerEvent.NodeErrorEvent -> _state.update { it.copy(error = event.error) }
                    else -> {}
                }
            }
    }
}
