import { IncomingMessage, ServerResponse } from "node:http";
import type { VercelResponse } from "@vercel/node";
import { ApplicationException } from "../../src/global/lib/error-handling";

export function formatErrorMessage<CodeT extends string>(
  err: ApplicationException<CodeT>,
) {
  return err.code == "UNKNOWN_ERROR"
    ? `Unknown error occured: ${err.message}`
    : err.message;
}

export function handleViteError<CodeT extends string>(
  statusCode: number,
  err: ApplicationException<CodeT>,
  res: ServerResponse<IncomingMessage>,
) {
  res.statusCode = statusCode;
  res.end(
    JSON.stringify({
      error: formatErrorMessage(err),
    }),
  );
  return;
}

export function handleVercelError<CodeT extends string>(
  statusCode: number,
  err: ApplicationException<CodeT>,
  res: VercelResponse,
) {
  return res.status(statusCode).json({
    error: formatErrorMessage(err),
  });
}
