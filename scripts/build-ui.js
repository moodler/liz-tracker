#!/usr/bin/env node

/**
 * UI Pre-compilation Script
 *
 * Combines core.html + space plugin JS files into a single index.html.
 * The marker `// __SPACE_PLUGINS__` in core.html is replaced with the
 * concatenated contents of all files in src/ui/spaces/*.js.
 *
 * Output: src/ui/index.html (build artifact, gitignored)
 * Source of truth: src/ui/core.html + src/ui/spaces/*.js
 *
 * Usage:
 *   node scripts/build-ui.js
 *   node --watch-path=src/ui scripts/build-ui.js  (auto-rebuild on change)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "..", "src", "ui");
const spacesDir = join(srcDir, "spaces");
const coreFile = join(srcDir, "core.html");
const outputFile = join(srcDir, "index.html");
const MARKER = "// __SPACE_PLUGINS__";

// Read core HTML shell
if (!existsSync(coreFile)) {
  console.error("Error: src/ui/core.html not found");
  process.exit(1);
}
let html = readFileSync(coreFile, "utf8");

// Collect space plugin JS files (sorted alphabetically for deterministic output)
let pluginBlock = "";
if (existsSync(spacesDir)) {
  const files = readdirSync(spacesDir)
    .filter(f => f.endsWith(".js"))
    .sort();

  const plugins = files.map(f => ({
    name: f,
    code: readFileSync(join(spacesDir, f), "utf8"),
  }));

  pluginBlock = plugins
    .map(p => `\n        // ── Space Plugin: ${p.name} ──\n${p.code}`)
    .join("\n");

  console.log(`Built src/ui/index.html with ${plugins.length} space plugin(s): ${files.join(", ")}`);
} else {
  console.log("Built src/ui/index.html with 0 space plugins (no src/ui/spaces/ directory)");
}

// Replace marker with plugin code
if (!html.includes(MARKER)) {
  console.error(`Error: Marker "${MARKER}" not found in core.html`);
  process.exit(1);
}
html = html.replace(MARKER, pluginBlock);

// Write combined output
writeFileSync(outputFile, html);
