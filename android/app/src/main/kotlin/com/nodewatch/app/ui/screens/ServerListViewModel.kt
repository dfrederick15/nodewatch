package com.nodewatch.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nodewatch.app.data.model.Server
import com.nodewatch.app.data.repository.NodewatchRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class ServerListViewModel @Inject constructor(
    private val repo: NodewatchRepository,
) : ViewModel() {

    val servers = repo.servers.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun delete(server: Server) = viewModelScope.launch { repo.deleteServer(server) }
}
