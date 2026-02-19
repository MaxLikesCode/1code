import * as fs from "fs/promises"
import type { Dirent } from "fs"
import * as path from "path"
import * as os from "os"
import { execFile } from "child_process"
import { promisify } from "util"
import type { McpServerConfig } from "../claude-config"
import { isDirentDirectory } from "../fs/dirent"

const execFileAsync = promisify(execFile)

export interface PluginInfo {
  name: string
  version: string
  description?: string
  path: string
  source: string // e.g., "marketplace:plugin-name"
  marketplace: string // e.g., "claude-plugins-official"
  category?: string
  homepage?: string
  tags?: string[]
}

interface MarketplacePlugin {
  name: string
  version?: string
  description?: string
  source: string | { source: string; url: string }
  category?: string
  homepage?: string
  tags?: string[]
}

interface MarketplaceJson {
  name: string
  plugins: MarketplacePlugin[]
}

export interface PluginMcpConfig {
  pluginSource: string // e.g., "ccsetup:ccsetup"
  mcpServers: Record<string, McpServerConfig>
}

// installed_plugins.json entry structure (from Claude Code CLI)
interface InstalledPluginEntry {
  scope: string
  installPath: string
  version: string
  installedAt: string
  lastUpdated: string
  gitCommitSha?: string
}

// installed_plugins.json format: { version: 2, plugins: { "name@marketplace": [entry, ...] } }
interface InstalledPluginsJson {
  version: number
  plugins: Record<string, InstalledPluginEntry[]>
}

/**
 * Read ~/.claude/plugins/installed_plugins.json to get install paths
 * Returns a map of "pluginName@marketplace" -> installPath
 */
async function loadInstalledPluginPaths(): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const installedPath = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json")
  try {
    const content = await fs.readFile(installedPath, "utf-8")
    const data: InstalledPluginsJson = JSON.parse(content)
    if (data.plugins && typeof data.plugins === "object") {
      for (const [key, entries] of Object.entries(data.plugins)) {
        if (Array.isArray(entries) && entries.length > 0) {
          // Use the most recent entry (last in array)
          const latest = entries[entries.length - 1]!
          if (latest.installPath) {
            result.set(key, latest.installPath)
          }
        }
      }
    }
  } catch {
    // installed_plugins.json doesn't exist or can't be parsed
  }
  return result
}

// Cache for plugin discovery results
let pluginCache: { plugins: PluginInfo[]; timestamp: number } | null = null
let mcpCache: { configs: PluginMcpConfig[]; timestamp: number } | null = null
const CACHE_TTL_MS = 30000 // 30 seconds - plugins don't change often during a session

/**
 * Clear plugin caches (for testing/manual invalidation)
 */
export function clearPluginCache() {
  pluginCache = null
  mcpCache = null
}

/**
 * Discover all installed plugins from ~/.claude/plugins/marketplaces/
 * Returns array of plugin info with paths to their component directories
 * Results are cached for 30 seconds to avoid repeated filesystem scans
 */
export async function discoverInstalledPlugins(): Promise<PluginInfo[]> {
  // Return cached result if still valid
  if (pluginCache && Date.now() - pluginCache.timestamp < CACHE_TTL_MS) {
    return pluginCache.plugins
  }

  const plugins: PluginInfo[] = []
  const marketplacesDir = path.join(os.homedir(), ".claude", "plugins", "marketplaces")

  try {
    await fs.access(marketplacesDir)
  } catch {
    pluginCache = { plugins, timestamp: Date.now() }
    return plugins
  }

  let marketplaces: Dirent[]
  try {
    marketplaces = await fs.readdir(marketplacesDir, { withFileTypes: true })
  } catch {
    pluginCache = { plugins, timestamp: Date.now() }
    return plugins
  }

  // Load installed plugin paths from installed_plugins.json
  // This is the authoritative source for where plugins are actually installed
  const installedPaths = await loadInstalledPluginPaths()

  for (const marketplace of marketplaces) {
    if (marketplace.name.startsWith(".")) continue

    const isMarketplaceDir = await isDirentDirectory(
      marketplacesDir,
      marketplace,
    )
    if (!isMarketplaceDir) continue

    const marketplacePath = path.join(marketplacesDir, marketplace.name)
    const marketplaceJsonPath = path.join(marketplacePath, ".claude-plugin", "marketplace.json")

    try {
      const content = await fs.readFile(marketplaceJsonPath, "utf-8")

      let marketplaceJson: MarketplaceJson
      try {
        marketplaceJson = JSON.parse(content)
      } catch {
        continue
      }

      if (!Array.isArray(marketplaceJson.plugins)) {
        continue
      }

      for (const plugin of marketplaceJson.plugins) {
        try {
          // Validate plugin.source exists
          if (!plugin.source) continue

          let pluginPath: string | null = null

          // 1. Check installed_plugins.json for cached install path (works for all source types)
          const installedKey = `${plugin.name}@${marketplaceJson.name}`
          const installedPath = installedPaths.get(installedKey)
          if (installedPath) {
            const exists = await fs
              .stat(installedPath)
              .then((s) => s.isDirectory())
              .catch(() => false)
            if (exists) {
              pluginPath = installedPath
            }
          }

          // 2. Fallback: resolve string source paths relative to marketplace dir
          if (!pluginPath && typeof plugin.source === "string") {
            const resolved = path.resolve(marketplacePath, plugin.source)
            const exists = await fs
              .stat(resolved)
              .then((s) => s.isDirectory())
              .catch(() => false)
            if (exists) {
              pluginPath = resolved
            }
          }

          if (!pluginPath) continue

          plugins.push({
            name: plugin.name,
            version: plugin.version || "0.0.0",
            description: plugin.description,
            path: pluginPath,
            source: `${marketplaceJson.name}:${plugin.name}`,
            marketplace: marketplaceJson.name,
            category: plugin.category,
            homepage: plugin.homepage,
            tags: plugin.tags,
          })
        } catch (pluginErr) {
          console.warn(
            `[plugins] Error processing plugin ${plugin.name} in ${marketplace.name}:`,
            pluginErr instanceof Error ? pluginErr.message : pluginErr,
          )
        }
      }
    } catch (marketplaceErr) {
      // Log non-ENOENT errors for debugging
      if ((marketplaceErr as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[plugins] Error processing marketplace ${marketplace.name}:`,
          marketplaceErr instanceof Error ? marketplaceErr.message : marketplaceErr,
        )
      }
    }
  }

  pluginCache = { plugins, timestamp: Date.now() }
  return plugins
}

/**
 * Get component paths for a plugin (commands, skills, agents directories)
 */
export function getPluginComponentPaths(plugin: PluginInfo) {
  return {
    commands: path.join(plugin.path, "commands"),
    skills: path.join(plugin.path, "skills"),
    agents: path.join(plugin.path, "agents"),
  }
}

/**
 * Discover MCP server configs from all installed plugins
 * Reads .mcp.json from each plugin directory
 * Results are cached for 30 seconds to avoid repeated filesystem scans
 */
export async function discoverPluginMcpServers(): Promise<PluginMcpConfig[]> {
  // Return cached result if still valid
  if (mcpCache && Date.now() - mcpCache.timestamp < CACHE_TTL_MS) {
    return mcpCache.configs
  }

  const plugins = await discoverInstalledPlugins()
  const configs: PluginMcpConfig[] = []

  for (const plugin of plugins) {
    const mcpJsonPath = path.join(plugin.path, ".mcp.json")
    try {
      const content = await fs.readFile(mcpJsonPath, "utf-8")
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(content)
      } catch {
        continue
      }

      // Support two formats:
      // Format A (flat): { "server-name": { "command": "...", ... } }
      // Format B (nested): { "mcpServers": { "server-name": { ... } } }
      const serversObj =
        parsed.mcpServers &&
        typeof parsed.mcpServers === "object" &&
        !Array.isArray(parsed.mcpServers)
          ? (parsed.mcpServers as Record<string, unknown>)
          : parsed

      const validServers: Record<string, McpServerConfig> = {}
      for (const [name, config] of Object.entries(serversObj)) {
        if (config && typeof config === "object" && !Array.isArray(config)) {
          validServers[name] = config as McpServerConfig
        }
      }

      if (Object.keys(validServers).length > 0) {
        configs.push({
          pluginSource: plugin.source,
          mcpServers: validServers,
        })
      }
    } catch {
      // No .mcp.json file, skip silently (this is expected for most plugins)
    }
  }

  // Cache the result
  mcpCache = { configs, timestamp: Date.now() }
  return configs
}

// ============================================
// Available (not-yet-installed) Plugin Discovery
// ============================================

export interface AvailablePlugin {
  name: string
  description?: string
  marketplace: string
  sourceUrl: string
  category?: string
  homepage?: string
  tags?: string[]
}

/**
 * Discover plugins from marketplace.json files that are not yet installed locally.
 * These are URL-based plugins whose source hasn't been git-cloned.
 */
export async function discoverAvailablePlugins(): Promise<AvailablePlugin[]> {
  const available: AvailablePlugin[] = []
  const marketplacesDir = path.join(os.homedir(), ".claude", "plugins", "marketplaces")

  try {
    await fs.access(marketplacesDir)
  } catch {
    return available
  }

  let marketplaces: Dirent[]
  try {
    marketplaces = await fs.readdir(marketplacesDir, { withFileTypes: true })
  } catch {
    return available
  }

  // Load installed plugin keys
  const installedPaths = await loadInstalledPluginPaths()

  for (const marketplace of marketplaces) {
    if (marketplace.name.startsWith(".")) continue

    const isMarketplaceDir = await isDirentDirectory(marketplacesDir, marketplace)
    if (!isMarketplaceDir) continue

    const marketplacePath = path.join(marketplacesDir, marketplace.name)
    const marketplaceJsonPath = path.join(marketplacePath, ".claude-plugin", "marketplace.json")

    try {
      const content = await fs.readFile(marketplaceJsonPath, "utf-8")
      let marketplaceJson: MarketplaceJson
      try {
        marketplaceJson = JSON.parse(content)
      } catch {
        continue
      }

      if (!Array.isArray(marketplaceJson.plugins)) continue

      for (const plugin of marketplaceJson.plugins) {
        // Only consider URL-based plugins that aren't installed
        if (!plugin.source || typeof plugin.source !== "object" || !plugin.source.url) continue

        const installedKey = `${plugin.name}@${marketplaceJson.name}`
        if (installedPaths.has(installedKey)) continue

        available.push({
          name: plugin.name,
          description: plugin.description,
          marketplace: marketplaceJson.name,
          sourceUrl: plugin.source.url,
          category: plugin.category,
          homepage: plugin.homepage,
          tags: plugin.tags,
        })
      }
    } catch {
      // Skip marketplaces that can't be read
    }
  }

  return available
}

// ============================================
// Plugin Installation
// ============================================

const INSTALLED_PLUGINS_PATH = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json")

/**
 * Read and parse installed_plugins.json, creating it if it doesn't exist
 */
async function readInstalledPluginsJson(): Promise<InstalledPluginsJson> {
  try {
    const content = await fs.readFile(INSTALLED_PLUGINS_PATH, "utf-8")
    return JSON.parse(content)
  } catch {
    return { version: 2, plugins: {} }
  }
}

/**
 * Write installed_plugins.json
 */
async function writeInstalledPluginsJson(data: InstalledPluginsJson): Promise<void> {
  await fs.mkdir(path.dirname(INSTALLED_PLUGINS_PATH), { recursive: true })
  await fs.writeFile(INSTALLED_PLUGINS_PATH, JSON.stringify(data, null, 2), "utf-8")
}

/**
 * Install a plugin by cloning its git URL into the cache directory.
 * Updates installed_plugins.json and clears caches.
 */
export async function installPlugin(
  marketplace: string,
  pluginName: string,
  sourceUrl: string,
): Promise<{ success: boolean; installPath?: string; error?: string }> {
  try {
    // Clone to a temp directory first, then move to versioned cache path
    const cacheBase = path.join(os.homedir(), ".claude", "plugins", "cache", marketplace, pluginName)
    await fs.mkdir(cacheBase, { recursive: true })

    // Clone into a temp dir
    const tempDir = path.join(cacheBase, "_cloning")
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch { /* ok */ }

    await execFileAsync("git", ["clone", "--depth", "1", sourceUrl, tempDir], {
      timeout: 120_000, // 2 min timeout
    })

    // Try to read version from package.json
    let version = "0.0.0"
    let gitCommitSha: string | undefined
    try {
      const pkgContent = await fs.readFile(path.join(tempDir, "package.json"), "utf-8")
      const pkg = JSON.parse(pkgContent)
      if (typeof pkg.version === "string") version = pkg.version
    } catch { /* no package.json, use default version */ }

    // Get git commit SHA
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tempDir })
      gitCommitSha = stdout.trim()
    } catch { /* ok */ }

    // Move to versioned directory
    const installPath = path.join(cacheBase, version)
    try {
      await fs.rm(installPath, { recursive: true, force: true })
    } catch { /* ok */ }
    await fs.rename(tempDir, installPath)

    // Update installed_plugins.json
    const data = await readInstalledPluginsJson()
    const key = `${pluginName}@${marketplace}`
    const now = new Date().toISOString()
    const entry: InstalledPluginEntry = {
      scope: "user",
      installPath,
      version,
      installedAt: now,
      lastUpdated: now,
      gitCommitSha,
    }

    if (!data.plugins[key]) {
      data.plugins[key] = []
    }
    data.plugins[key].push(entry)
    await writeInstalledPluginsJson(data)

    // Clear caches so new plugin is discovered
    clearPluginCache()

    return { success: true, installPath }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Uninstall a plugin by removing its cache directory and installed_plugins.json entry.
 */
export async function uninstallPlugin(
  marketplace: string,
  pluginName: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const key = `${pluginName}@${marketplace}`

    // Remove from installed_plugins.json
    const data = await readInstalledPluginsJson()
    const entries = data.plugins[key]
    if (entries && entries.length > 0) {
      // Remove the cache directory for the latest entry
      const latest = entries[entries.length - 1]!
      if (latest.installPath) {
        try {
          await fs.rm(latest.installPath, { recursive: true, force: true })
        } catch { /* ok if dir doesn't exist */ }
      }
    }
    delete data.plugins[key]
    await writeInstalledPluginsJson(data)

    // Clear caches
    clearPluginCache()

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
