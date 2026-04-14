import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import { getStatusCode, handleRequest } from "../src/api/query";
import { QueryErrorHandler } from "../src/api/query/errors";
import { handleViteError, handleVercelError } from "../src/api/error-handling";

export async function viteHandler(
  req: Connect.IncomingMessage,
  res: ServerResponse<IncomingMessage>,
) {
  try {
    const result = await handleRequest(
      req.method,
      req.headers.authorization,
      process.env.DATABASE_URL,
      () =>
        new Promise((resolve, reject) => {
          let body = "";
          req.on("data", (chunk: Buffer) => (body += chunk.toString()));
          req.on("end", () => {
            try {
              resolve(JSON.parse(body || "{}"));
            } catch (e) {
              reject(e);
            }
          });
        }),
      true, // skipAuth in dev
    );
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (e) {
    const err = QueryErrorHandler.wrapError(e);
    handleViteError(getStatusCode(err), err, res);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const result = await handleRequest(
      req.method,
      req.headers.authorization,
      process.env.DATABASE_URL,
      async () => req.body ?? {},
    );
    return res.status(200).json(result);
  } catch (e) {
    const err = QueryErrorHandler.wrapError(e);
    return handleVercelError(getStatusCode(err), err, res);
  }
}
