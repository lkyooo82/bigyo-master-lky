import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and must see Rust compile errors in the terminal.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5174, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
});
