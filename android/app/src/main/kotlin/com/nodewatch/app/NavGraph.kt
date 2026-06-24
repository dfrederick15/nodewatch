package com.nodewatch.app

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.nodewatch.app.ui.screens.*

sealed class Route(val path: String) {
    object ServerList : Route("servers")
    object AddServer  : Route("servers/add")
    data class EditServer(val id: String = "{serverId}") : Route("servers/{serverId}/edit")
    data class Dashboard(val id: String = "{serverId}") : Route("servers/{serverId}/dashboard")
    data class NodeDetail(val serverId: String = "{serverId}", val node: String = "{node}") :
        Route("servers/{serverId}/nodes/{node}")
    data class ServerSettings(val id: String = "{serverId}") : Route("servers/{serverId}/settings")
    data class Favorites(val id: String = "{serverId}") : Route("servers/{serverId}/favorites")
}

@Composable
fun NodewatchNavGraph(navController: NavHostController = rememberNavController()) {
    NavHost(navController, startDestination = Route.ServerList.path) {
        composable(Route.ServerList.path) {
            ServerListScreen(
                onAddServer = { navController.navigate(Route.AddServer.path) },
                onServerSelected = { id -> navController.navigate("servers/$id/dashboard") },
                onEditServer = { id -> navController.navigate("servers/$id/edit") },
            )
        }
        composable(Route.AddServer.path) {
            AddServerScreen(onDone = { navController.popBackStack() })
        }
        composable(
            Route.EditServer().path,
            arguments = listOf(navArgument("serverId") { type = NavType.StringType }),
        ) { back ->
            val id = back.arguments!!.getString("serverId")!!
            AddServerScreen(serverId = id, onDone = { navController.popBackStack() })
        }
        composable(
            Route.Dashboard().path,
            arguments = listOf(navArgument("serverId") { type = NavType.StringType }),
        ) { back ->
            val id = back.arguments!!.getString("serverId")!!
            DashboardScreen(
                serverId = id,
                onNodeTap = { node -> navController.navigate("servers/$id/nodes/$node") },
                onFavoritesTap = { navController.navigate("servers/$id/favorites") },
                onSettingsTap = { navController.navigate("servers/$id/settings") },
            )
        }
        composable(
            Route.NodeDetail().path,
            arguments = listOf(
                navArgument("serverId") { type = NavType.StringType },
                navArgument("node") { type = NavType.StringType },
            ),
        ) { back ->
            val serverId = back.arguments!!.getString("serverId")!!
            val node = back.arguments!!.getString("node")!!
            NodeDetailScreen(serverId = serverId, node = node, onBack = { navController.popBackStack() })
        }
        composable(
            Route.Favorites().path,
            arguments = listOf(navArgument("serverId") { type = NavType.StringType }),
        ) { back ->
            val id = back.arguments!!.getString("serverId")!!
            FavoritesScreen(serverId = id, onBack = { navController.popBackStack() })
        }
        composable(
            Route.ServerSettings().path,
            arguments = listOf(navArgument("serverId") { type = NavType.StringType }),
        ) { back ->
            val id = back.arguments!!.getString("serverId")!!
            ServerSettingsScreen(serverId = id, onDeleted = { navController.navigate(Route.ServerList.path) { popUpTo(0) } })
        }
    }
}
