package com.nodewatch.app.data.remote

import com.nodewatch.app.data.model.Server
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class ApiClientTest {
    private lateinit var mockServer: MockWebServer
    private lateinit var client: ApiClient
    private lateinit var server: Server

    @Before fun setUp() {
        mockServer = MockWebServer()
        mockServer.start()
        client = ApiClient(OkHttpClient())
        server = Server(host = mockServer.hostName, port = mockServer.port, name = "test")
    }

    @After fun tearDown() { mockServer.shutdown() }

    @Test
    fun `login returns token on 200`() = runTest {
        mockServer.enqueue(MockResponse().setResponseCode(200).setBody("""{"token":"abc123"}"""))
        val result = client.login(server, "admin", "pass", "TestDevice")
        assertTrue(result.isSuccess)
        assertEquals("abc123", result.getOrNull())
    }

    @Test
    fun `login returns failure on 401`() = runTest {
        mockServer.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"Invalid credentials"}"""))
        val result = client.login(server, "admin", "wrong", "TestDevice")
        assertTrue(result.isFailure)
    }

    @Test
    fun `connect sends correct ilink code for transceive temp`() = runTest {
        mockServer.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client.connect(server, "token", "1234", "5678", ConnectMode.TRANSCEIVE, permanent = false)
        val req = mockServer.takeRequest()
        assertEquals("POST", req.method)
        assertTrue(req.body.readUtf8().contains("\"mode\":\"connect\""))
    }
}
