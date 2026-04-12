import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";

/**
 * Dev-only middleware that handles POST /api/query against Neon,
 * so we don't need `vercel dev` locally.
 */
function devApiProxy(): Plugin {
  return {
    name: "dev-api-proxy",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/query" || req.method !== "POST") return next();

        const { neon } = await import("@neondatabase/serverless");
        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "DATABASE_URL not set in .env" }));
          return;
        }

        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", async () => {
          try {
            const { sql: query, params = [] } = JSON.parse(body || "{}");
            const trimmed = typeof query === "string" ? query.trim() : "";
            if (!trimmed || !trimmed.toUpperCase().startsWith("SELECT")) {
              res.statusCode = 403;
              res.end(
                JSON.stringify({ error: "Only SELECT statements allowed" }),
              );
              return;
            }
            const forbidden =
              /;|--|\/\*|\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|COPY)\b/i;
            if (forbidden.test(trimmed)) {
              res.statusCode = 403;
              res.end(
                JSON.stringify({ error: "Forbidden SQL pattern detected" }),
              );
              return;
            }
            const sql = neon(dbUrl);
            const rows = await sql.query(query, params);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ rows, rowCount: rows.length }));
          } catch (e: unknown) {
            console.error("Dev API proxy error:", e);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "Query execution failed" }));
          }
        });
      });
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
  };
});
