/**
 * Space Plugin Registry — Server-Side
 *
 * Provides: registerSpace(), getSpacePlugin(), listSpacePlugins(),
 *           getSpaceTypes(), getCoverSpaceTypes()
 *
 * Central Map-based registry that replaces hardcoded SPACE_TYPES constants
 * and if-else chains. Plugins self-register via the explicit manifest
 * in ./index.ts — no convention-based auto-discovery.
 */

import type { SpacePlugin } from "./types.js";

const plugins = new Map<string, SpacePlugin>();

/**
 * Register a space plugin. Throws if a plugin with the same name already exists.
 */
export function registerSpace(plugin: SpacePlugin): void {
  if (plugins.has(plugin.name)) {
    throw new Error(`Space "${plugin.name}" already registered`);
  }
  plugins.set(plugin.name, plugin);
}

/**
 * Get a registered space plugin by name. Returns undefined if not found.
 */
export function getSpacePlugin(name: string): SpacePlugin | undefined {
  return plugins.get(name);
}

/**
 * List all registered space plugins.
 */
export function listSpacePlugins(): SpacePlugin[] {
  return [...plugins.values()];
}

/**
 * Get a SPACE_TYPES-compatible object for the UI.
 * Returns a Record mapping space name to { name, label, icon, description }.
 */
export function getSpaceTypes(): Record<string, { name: string; label: string; icon: string; description: string }> {
  const types: Record<string, { name: string; label: string; icon: string; description: string }> = {};
  for (const [name, p] of plugins) {
    types[name] = { name: p.name, label: p.label, icon: p.icon, description: p.description };
  }
  return types;
}

/**
 * Get the list of space type names that support cover images.
 */
export function getCoverSpaceTypes(): string[] {
  return [...plugins.values()].filter(p => p.capabilities.coverImage).map(p => p.name);
}

/**
 * Clear all registered plugins. Used for testing.
 */
export function _clearRegistry(): void {
  plugins.clear();
}
