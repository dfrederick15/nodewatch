package com.nodewatch.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nodewatch.app.data.model.FavoriteNodeStatus
import com.nodewatch.app.data.repository.NodewatchRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class FavoritesViewModel @Inject constructor(private val repo: NodewatchRepository) : ViewModel() {

    private val _favorites = MutableStateFlow<List<FavoriteNodeStatus>>(emptyList())
    val favorites = _favorites.asStateFlow()
    private val _loading = MutableStateFlow(false)
    val loading = _loading.asStateFlow()

    fun init(serverId: String) = viewModelScope.launch {
        val server = repo.servers.first().find { it.id == serverId } ?: return@launch
        while (true) {
            _loading.value = true
            repo.getFavoriteStatuses(server).onSuccess { _favorites.value = it }
            _loading.value = false
            delay(30_000)
        }
    }
}
