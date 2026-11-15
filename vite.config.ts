import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig, type Plugin } from 'vite'
import { p2pRelayPlugin } from './vite-relay-plugin.js'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string }
const appVersion = pkg.version || '0.0.0'

let appCommit = 'dev'
try {
  appCommit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev'
} catch {}

/** Stamps the build version + commit into dist/sw.js so deploys automatically rotate SW caches. */
function swVersionPlugin(versionTag: string): Plugin {
  return {
    name: 'sw-version-stamp',
    apply: 'build',
    closeBundle() {
      const swPath = resolve(import.meta.dirname, 'dist/sw.js')
      if (!existsSync(swPath)) return
      const content = readFileSync(swPath, 'utf8')
        .replace(/const CACHE_NAME = '[^']+';/, `const CACHE_NAME = 'braindance-shell-${versionTag}';`)
        .replace(/const RUNTIME_CACHE = '[^']+';/, `const RUNTIME_CACHE = 'braindance-runtime-${versionTag}';`)
      writeFileSync(swPath, content, 'utf8')
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_COMMIT__: JSON.stringify(appCommit),
  },
  plugins: [svelte(), p2pRelayPlugin(), swVersionPlugin(`v${appVersion}-${appCommit}`)],
  server: {
    host: true, // Listen on all network interfaces
    // TODO: In production / central hosting, restrict allowedHosts to known domains to prevent DNS rebinding attacks.
    allowedHosts: true, // Allow any host (e.g. *.loca.lt, ngrok, custom tunnels)
  },
})
