import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // fs.watch cannot watch files over a WSL share mount (Z:\…, EISDIR/EPERM);
    // polling works on native filesystems too, just with more CPU.
    watch: { usePolling: true, interval: 300 },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
});
