import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const runtimeEnv = (globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/artifacts/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: runtimeEnv.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !runtimeEnv.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!runtimeEnv.TAURI_ENV_DEBUG,
    rollupOptions: { input: ["index.html", "main.html", "dashboard.html", "dock.html"] },
  },
});
