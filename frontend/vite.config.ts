import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Cible du proxy API : localhost en dev local, http://backend:8000 dans compose.dev.yaml.
const apiTarget = process.env.VITE_API_PROXY || "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": apiTarget,
      "/exports": apiTarget,
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
