import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import { p2pRelayPlugin } from './vite-relay-plugin.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), p2pRelayPlugin()],
  server: {
    host: true, // Listen on all network interfaces
    // TODO: In production / central hosting, restrict allowedHosts to known domains to prevent DNS rebinding attacks.
    allowedHosts: true, // Allow any host (e.g. *.loca.lt, ngrok, custom tunnels)
  },
})
