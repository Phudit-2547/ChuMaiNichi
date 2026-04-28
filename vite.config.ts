import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import path from "path";

import { viteHandler as queryViteHandler } from "./api/query";
import chatHandler from "./api/chat";
import refreshHandler from "./api/refresh";
import modelHandler from "./api/model";
import coverHandler from "./api/cover";
import ratingImageHandler from "./api/rating-image";
import { toViteMiddleware } from "./src/api/vite-adapter";

/**
 * Dev-only middleware that emulates Vercel serverless functions,
 * so we don't need `vercel dev` locally.
 */
function devApiProxy(): Plugin {
  return {
    name: "dev-api-proxy",
    configureServer(server) {
      server.middlewares.use("/api/query", queryViteHandler);
      server.middlewares.use(
        "/api/chat",
        toViteMiddleware(chatHandler, { skipAuth: true }),
      );
      server.middlewares.use(
        "/api/refresh",
        toViteMiddleware(refreshHandler, { skipAuth: true }),
      );
      server.middlewares.use(
        "/api/model",
        toViteMiddleware(modelHandler, { skipAuth: true }),
      );
      server.middlewares.use(
        "/api/cover",
        toViteMiddleware(coverHandler),
      );
      server.middlewares.use(
        "/api/rating-image",
        toViteMiddleware(ratingImageHandler, { skipAuth: true }),
      );
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
