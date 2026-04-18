import { neon } from "@neondatabase/serverless";
import { checkAuth } from "./auth";
import { QueryException } from "./query/errors";

const FORBIDDEN =
  /;|--|\/\*|\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|COPY|INTO)\b/i;

type QueryResult = { rows: unknown[]; rowCount: number };

export async function runQuery(
  query: unknown,
  params: unknown,
  dbUrl: string,
): Promise<QueryResult> {
  if (typeof query !== "string")
    throw new QueryException("QUERY_NOT_GIVEN", "SQL query not given");
  if (!Array.isArray(params))
    throw new QueryException("PARAMS_NOT_AN_ARRAY", "params must be an array");

  const trimmed = query.trim();
  if (!trimmed.toUpperCase().startsWith("SELECT"))
    throw new QueryException(
      "NOT_SELECT_QUERY",
      "Only SELECT statements are allowed",
    );
  if (FORBIDDEN.test(trimmed))
    throw new QueryException(
      "FORBIDDEN_QUERY",
      "Forbidden SQL pattern detected",
    );

  const sql = neon(dbUrl);
  const rows = await sql.query(query, params);
  return { rows, rowCount: rows.length };
}

export function getStatusCode(e: QueryException) {
  switch (e.code) {
    case "QUERY_NOT_GIVEN":
    case "PARAMS_NOT_AN_ARRAY": {
      return 400;
    }
    case "INVALID_CREDENTIALS": {
      return 401;
    }
    case "FORBIDDEN_QUERY":
    case "NOT_SELECT_QUERY": {
      return 403;
    }
    case "METHOD_NOT_ALLOWED": {
      return 405;
    }
    case "DATABASE_URL_NOT_SET":
    case "UNKNOWN_ERROR":
    default: {
      return 500;
    }
  }
}

export async function handleRequest(
  method: string | undefined,
  authHeader: string | undefined,
  dbUrl: string | undefined,
  getBody: () => Promise<{ sql: unknown; params?: unknown[] }>,
  skipAuth = false,
): Promise<unknown> {
  if (method !== "POST")
    throw new QueryException("METHOD_NOT_ALLOWED", "Method not allowed");

  if (!skipAuth && !checkAuth(authHeader, process.env.DASHBOARD_PASSWORD))
    throw new QueryException(
      "INVALID_CREDENTIALS",
      "Incorrect dashboard password",
    );

  if (!dbUrl)
    throw new QueryException("DATABASE_URL_NOT_SET", "DATABASE_URL not set");

  const { sql: query, params = [] } = await getBody();
  return runQuery(query, params, dbUrl);
}
