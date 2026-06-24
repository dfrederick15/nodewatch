package com.nodewatch.app.data.storage

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class TokenStore @Inject constructor(@ApplicationContext private val ctx: Context) {

    private val prefs by lazy {
        val master = MasterKey.Builder(ctx)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            ctx, "nodewatch_tokens", master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun getToken(serverId: String): String? = prefs.getString(serverId, null)

    suspend fun setToken(serverId: String, token: String) {
        withContext(Dispatchers.IO) {
            prefs.edit().putString(serverId, token).apply()
        }
    }

    suspend fun deleteToken(serverId: String) {
        withContext(Dispatchers.IO) {
            prefs.edit().remove(serverId).apply()
        }
    }
}
