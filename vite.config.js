import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Cualquier request a /api/* se redirige al proxy Express
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
