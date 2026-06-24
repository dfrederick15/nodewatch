package com.nodewatch.app.data.remote

import com.nodewatch.app.data.model.Server
import com.nodewatch.app.data.model.ServerEvent
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class SseClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: SseClient

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
        client = SseClient(OkHttpClient())
    }

    @After fun tearDown() { server.shutdown() }

    @Test
    fun `emits NodeStatusEvent from SSE stream`() = runTest {
        val body = "event: node_status\ndata: {\"node\":\"1234\",\"cos_keyed\":false,\"tx_keyed\":false,\"connections\":[]}\n\n"
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .addHeader("Content-Type", "text/event-stream")
                .setBody(body)
        )
        val s = Server(host = server.hostName, port = server.port, name = "test")
        val event = client.events(s, "token").first()
        assertTrue(event is ServerEvent.NodeStatusEvent)
    }
}
