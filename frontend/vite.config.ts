import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.ENCORE_API ?? "http://localhost:8765";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "../backend/encore/static", emptyOutDir: true },
  server: {
    host: true,
    proxy: { "/api": { target: api, ws: true }, "/media": api, "/backgrounds": api },
  },
});
