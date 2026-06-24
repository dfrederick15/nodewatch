package com.nodewatch.app.data.repository

import com.nodewatch.app.data.model.FavoriteNodeStatus
import com.nodewatch.app.data.model.Server
import com.nodewatch.app.data.model.ServerEvent
import com.nodewatch.app.data.remote.ApiClient
import com.nodewatch.app.data.remote.ConnectMode
import com.nodewatch.app.data.remote.SseClient
import com.nodewatch.app.data.storage.ServerStore
import com.nodewatch.app.data.storage.TokenStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class NodewatchRepository @Inject constructor(
    private val api: ApiClient,
    private val sse: SseClient,
    private val serverStore: ServerStore,
    private val tokenStore: TokenStore,
) {
    val servers = serverStore.servers

    fun nodeEvents(server: Server): Flow<ServerEvent> = flow {
        val token = tokenStore.getToken(server.id) ?: return@flow
        emitAll(sse.events(server, token))
    }

    suspend fun login(server: Server, username: String, password: String, label: String): Result<Unit> {
        val result = api.login(server, username, password, label)
        if (result.isSuccess) {
            serverStore.save(server)
            tokenStore.setToken(server.id, result.getOrThrow())
        }
        return result.map {}
    }

    suspend fun updateServer(server: Server) = serverStore.update(server)

    suspend fun connect(
        server: Server, localNode: String, remoteNode: String,
        mode: ConnectMode, permanent: Boolean,
    ): Result<Unit> {
        val token = tokenStore.getToken(server.id) ?: return Result.failure(Exception("Not authenticated"))
        return api.connect(server, token, localNode, remoteNode, mode, permanent)
    }

    suspend fun disconnect(
        server: Server, localNode: String, remoteNode: String, permanent: Boolean,
    ): Result<Unit> {
        val token = tokenStore.getToken(server.id) ?: return Result.failure(Exception("Not authenticated"))
        return api.disconnect(server, token, localNode, remoteNode, permanent)
    }

    suspend fun sendDtmf(server: Server, node: String, digits: String): Result<Unit> {
        val token = tokenStore.getToken(server.id) ?: return Result.failure(Exception("Not authenticated"))
        return api.sendDtmf(server, token, node, digits)
    }

    suspend fun getFavoriteStatuses(server: Server): Result<List<FavoriteNodeStatus>> {
        val token = tokenStore.getToken(server.id) ?: return Result.failure(Exception("Not authenticated"))
        return api.getFavoriteStatuses(server, token)
    }

    suspend fun deleteServer(server: Server): Result<Unit> = runCatching {
        val token = tokenStore.getToken(server.id)
        if (token != null) {
            api.revokeToken(server, token)
            tokenStore.deleteToken(server.id)
        }
        serverStore.delete(server.id)
    }
}
