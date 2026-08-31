const PRIVATE_CREDENTIAL_TABLE = /\bcodex_oauth_credentials\b/i;
const UNICODE_ESCAPED_IDENTIFIER = /\bU\s*&\s*"/i;
const ESCAPE_STRING = /\bE\s*'/i;
const DOLLAR_QUOTE = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;
const SYSTEM_CATALOG = /\b(?:pg_catalog|information_schema|pg_[A-Za-z0-9_$]*)\b/i;

// Generic dashboard SQL intentionally supports a small analytics vocabulary.
// Keeping callable functions allowlisted prevents SELECT-only escape hatches
// such as query_to_xml/dblink from executing dynamically assembled SQL against
// the encrypted OAuth table.
const ALLOWED_CALLS = new Set([
  "abs",
  "all",
  "and",
  "any",
  "array_agg",
  "array_length",
  "as",
  "avg",
  "bool_and",
  "bool_or",
  "btrim",
  "cardinality",
  "cast",
  "ceil",
  "ceiling",
  "coalesce",
  "concat",
  "concat_ws",
  "count",
  "date_bin",
  "date_part",
  "date_trunc",
  "dense_rank",
  "exists",
  "extract",
  "filter",
  "floor",
  "from",
  "greatest",
  "in",
  "join",
  "json_agg",
  "jsonb_agg",
  "jsonb_array_elements",
  "jsonb_array_elements_text",
  "jsonb_array_length",
  "jsonb_build_array",
  "jsonb_build_object",
  "jsonb_extract_path",
  "jsonb_extract_path_text",
  "jsonb_object_keys",
  "jsonb_path_exists",
  "jsonb_path_query",
  "jsonb_path_query_array",
  "jsonb_path_query_first",
  "jsonb_to_record",
  "jsonb_to_recordset",
  "jsonb_typeof",
  "lag",
  "lead",
  "least",
  "length",
  "lower",
  "ltrim",
  "make_date",
  "max",
  "min",
  "not",
  "now",
  "nullif",
  "on",
  "or",
  "over",
  "percentile_cont",
  "percentile_disc",
  "position",
  "rank",
  "regexp_matches",
  "regexp_replace",
  "replace",
  "round",
  "row_number",
  "rtrim",
  "select",
  "split_part",
  "stddev",
  "stddev_pop",
  "stddev_samp",
  "substring",
  "sum",
  "time",
  "timezone",
  "to_char",
  "to_date",
  "to_timestamp",
  "trim",
  "unnest",
  "upper",
  "variance",
  "var_pop",
  "var_samp",
  "where",
]);

function stripSingleQuotedStrings(sql: string): string | null {
  let result = "";
  for (let index = 0; index < sql.length; index++) {
    if (sql[index] !== "'") {
      result += sql[index];
      continue;
    }

    result += "''";
    let closed = false;
    for (index += 1; index < sql.length; index++) {
      if (sql[index] !== "'") continue;
      if (sql[index + 1] === "'") {
        index += 1;
        continue;
      }
      closed = true;
      break;
    }
    if (!closed) return null;
  }
  return result;
}

export function privateSqlBoundaryError(sql: string): string | null {
  if (ESCAPE_STRING.test(sql) || DOLLAR_QUOTE.test(sql)) {
    return "Encoded SQL strings are unavailable in dashboard queries";
  }

  const inspectable = stripSingleQuotedStrings(sql);
  if (inspectable === null) return "Invalid SQL string literal";
  if (PRIVATE_CREDENTIAL_TABLE.test(inspectable)) {
    return "Private credential storage is unavailable to dashboard queries";
  }
  if (SYSTEM_CATALOG.test(inspectable)) {
    return "PostgreSQL system catalogs are unavailable in dashboard queries";
  }
  if (UNICODE_ESCAPED_IDENTIFIER.test(inspectable)) {
    return "Unicode-escaped identifiers are unavailable in dashboard queries";
  }
  if (inspectable.includes('"')) {
    return "Quoted identifiers are unavailable in dashboard queries";
  }

  const callPattern = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*\(/g;
  for (const match of inspectable.matchAll(callPattern)) {
    const name = match[1].toLowerCase();
    if (!ALLOWED_CALLS.has(name)) {
      return `SQL function '${name}' is unavailable in dashboard queries`;
    }
  }
  return null;
}
