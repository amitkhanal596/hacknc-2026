import { defineConfig } from "vite";
export default defineConfig({
  root: "web",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
    },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
