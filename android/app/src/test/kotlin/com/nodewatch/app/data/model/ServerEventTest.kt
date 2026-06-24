package com.nodewatch.app.data.model

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerEventTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `parses node_status event`() {
        val data = """{"node":"1234","cos_keyed":false,"tx_keyed":true,"connections":[]}"""
        val event = ServerEvent.fromSse("node_status", data, json)
        assertTrue(event is ServerEvent.NodeStatusEvent)
        val ns = (event as ServerEvent.NodeStatusEvent).status
        assertEquals("1234", ns.node)
        assertEquals(true, ns.txKeyed)
    }

    @Test
    fun `parses node_times event`() {
        val data = """{"node":"1234","connections":[{"node":"5678","elapsed":120,"last_keyed":5}]}"""
        val event = ServerEvent.fromSse("node_times", data, json)
        assertTrue(event is ServerEvent.NodeTimesEvent)
        val nt = (event as ServerEvent.NodeTimesEvent).times
        assertEquals("1234", nt.node)
        assertEquals(1, nt.connections.size)
        assertEquals(120, nt.connections[0].elapsed)
    }

    @Test
    fun `parses node_error event`() {
        val data = """{"node":"1234","error":"connection refused"}"""
        val event = ServerEvent.fromSse("node_error", data, json)
        assertTrue(event is ServerEvent.NodeErrorEvent)
        assertEquals("connection refused", (event as ServerEvent.NodeErrorEvent).error)
    }

    @Test
    fun `unknown event type returns Unknown`() {
        val event = ServerEvent.fromSse("future_event", "{}", json)
        assertTrue(event is ServerEvent.Unknown)
    }
}
