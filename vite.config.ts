import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import path from "path";

import { viteHandler as queryViteHandler } from "./api/query";

/**
 * Dev-only middleware that handles POST /api/query against Neon,
 * so we don't need `vercel dev` locally.
 */
function devApiProxy(): Plugin {
  return {
    name: "dev-api-proxy",
    configureServer(server) {
      server.middlewares.use("/api/query", queryViteHandler);
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load .env so DATABASE_URL is available in process.env
  const env = loadEnv(mode, process.cwd(), "");
  Object.assign(process.env, env);

  return {
    plugins: [react(), devApiProxy(), tailwindcss()],
    build: {
      chunkSizeWarningLimit: 1000,
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
