import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
  },
  server: {
    port: 4311,
    proxy: {
      "/api": "http://localhost:4310",
    },
  },
});

