package com.nodewatch.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val DarkColors = darkColorScheme(
    primary = Color(0xFF4CAF50),
    onPrimary = Color.Black,
    secondary = Color(0xFF81C784),
    surface = Color(0xFF1E1E1E),
    background = Color(0xFF121212),
)

@Composable
fun NodewatchTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = DarkColors, content = content)
}
