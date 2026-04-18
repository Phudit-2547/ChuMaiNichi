import type { Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import type { VercelRequest, VercelResponse } from "@vercel/node";

type VercelHandler = (
  req: VercelRequest,
  res: VercelResponse,
) => unknown | Promise<unknown>;

export function toViteMiddleware(
  handler: VercelHandler,
  options: { skipAuth?: boolean } = {},
): Connect.NextHandleFunction {
  return async (
    req: Connect.IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    next: Connect.NextFunction,
  ) => {
    try {
      if (options.skipAuth && process.env.DASHBOARD_PASSWORD) {
        req.headers.authorization = `Bearer ${process.env.DASHBOARD_PASSWORD}`;
      }
      const body = await parseBody(req);
      const vercelReq = adaptReq(req, body);
      const vercelRes = adaptRes(res);
      await handler(vercelReq, vercelRes);
    } catch (err) {
      next(err as Error);
    }
  };
}

function adaptReq(
  req: Connect.IncomingMessage,
  body: unknown,
): VercelRequest {
  const out = req as unknown as VercelRequest & {
    body: unknown;
    query: Record<string, string | string[]>;
  };
  out.body = body;
  out.query = parseQuery(req.url);
  return out;
}

function adaptRes(res: ServerResponse): VercelResponse {
  const out = res as unknown as VercelResponse;

  out.status = (code: number) => {
    res.statusCode = code;
    return out;
  };

  out.json = (data: unknown) => {
    if (!res.getHeader("Content-Type")) {
      res.setHeader("Content-Type", "application/json");
    }
    res.end(JSON.stringify(data));
    return out;
  };

  out.send = (data: unknown) => {
    if (typeof data === "string" || Buffer.isBuffer(data)) {
      res.end(data);
    } else {
      out.json(data);
    }
    return out;
  };

  return out;
}

async function parseBody(req: Connect.IncomingMessage): Promise<unknown> {
  const method = req.method?.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "DELETE") {
    return undefined;
  }
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function parseQuery(url: string | undefined): Record<string, string | string[]> {
  if (!url) return {};
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return {};
  const params = new URLSearchParams(url.slice(qIdx + 1));
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of params) {
    const existing = out[k];
    if (existing === undefined) out[k] = v;
    else if (Array.isArray(existing)) existing.push(v);
    else out[k] = [existing, v];
  }
  return out;
}
