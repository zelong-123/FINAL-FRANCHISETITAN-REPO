import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The git tree hash of the API code this frontend is built against (null without git). The live
// API reports the same hash on GET /health; the Admin version banner compares the two.
const git = (cmd) => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch { return null; } };
const apiTree = git('git rev-parse HEAD:supabase/functions/api');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  define: { __APP_API_TREE__: JSON.stringify(apiTree) },
});
