package com.nodewatch.app.data.storage

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.nodewatch.app.data.model.Server
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Singleton

private val Context.dataStore by preferencesDataStore("servers")

@Singleton
class ServerStore @Inject constructor(@ApplicationContext private val ctx: Context) {

    private val KEY = stringPreferencesKey("server_list")

    val servers: Flow<List<Server>> = ctx.dataStore.data.map { prefs ->
        val raw = prefs[KEY] ?: return@map emptyList()
        runCatching { Json.decodeFromString<List<Server>>(raw) }.getOrDefault(emptyList())
    }

    suspend fun save(server: Server) = edit { list -> list + server }
    suspend fun update(server: Server) = edit { list -> list.map { if (it.id == server.id) server else it } }
    suspend fun delete(id: String) = edit { list -> list.filter { it.id != id } }

    private suspend fun edit(transform: (List<Server>) -> List<Server>) {
        ctx.dataStore.edit { prefs ->
            val current = runCatching {
                Json.decodeFromString<List<Server>>(prefs[KEY] ?: "[]")
            }.getOrDefault(emptyList())
            prefs[KEY] = Json.encodeToString(transform(current))
        }
    }
}
