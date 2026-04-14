import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { Connect } from "vite";
import { IncomingMessage, ServerResponse } from "node:http";
import { checkAuth } from "./_lib/auth";
import { runQuery, getStatusCode } from "./_lib/query";
import { QueryErrorHandler, QueryException } from "./_lib/query/errors";
import { handleViteError, handleVercelError } from "./_lib/error-handling";

export async function viteHandler(
  req: Connect.IncomingMessage,
  res: ServerResponse<IncomingMessage>,
) {
  try {
    if (req.method !== "POST")
      throw new QueryException("METHOD_NOT_ALLOWED", "Method not allowed");

    // // Dev: No auth
    // if (!checkAuth(req.headers.authorization, process.env.DASHBOARD_PASSWORD))
    //   throw new QueryException(
    //     "INVALID_CREDENTIALS",
    //     "Incorrect dashboard password",
    //   );

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl)
      throw new QueryException("DATABASE_URL_NOT_SET", "DATABASE_URL not set");

    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", async () => {
      try {
        const { sql: query, params = [] } = JSON.parse(body || "{}");
        const result = await runQuery(query, params, dbUrl);
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 200;
        res.end(JSON.stringify(result));
      } catch (e) {
        const wrappedError = QueryErrorHandler.wrapError(e);
        handleViteError(getStatusCode(wrappedError), wrappedError, res);
        return;
      }
    });
  } catch (e) {
    const wrappedError = QueryErrorHandler.wrapError(e);
    return handleViteError(getStatusCode(wrappedError), wrappedError, res);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST")
      throw new QueryException("METHOD_NOT_ALLOWED", "Method not allowed");

    if (!checkAuth(req.headers.authorization, process.env.DASHBOARD_PASSWORD))
      throw new QueryException(
        "INVALID_CREDENTIALS",
        "Incorrect dashboard password",
      );

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl)
      throw new QueryException("DATABASE_URL_NOT_SET", "DATABASE_URL not set");

    const { sql: query, params = [] } = req.body ?? {};

    const result = await runQuery(query, params, dbUrl);
    return res.status(200).json(result);
  } catch (e) {
    const wrappedError = QueryErrorHandler.wrapError(e);
    return handleVercelError(getStatusCode(wrappedError), wrappedError, res);
  }
}
