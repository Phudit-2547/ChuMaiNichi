import { Fragment, type ReactNode } from "react";

const TOKEN_RE =
  /(SELECT|FROM|WHERE|ORDER BY|GROUP BY|LIMIT|AND|OR|INTERVAL|CURRENT_DATE|EXTRACT|SUM|COUNT|AVG|AS|IS NOT NULL|IS NULL|DATE_TRUNC|YEAR|'[^']*'|\d+)/g;

export function renderSQL(sql: string): ReactNode {
  const tokens: { t: string; c?: string }[] = [];
  let i = 0;
  sql.replace(TOKEN_RE, (m, _g, off: number) => {
    if (off > i) tokens.push({ t: sql.slice(i, off) });
    if (m.startsWith("'")) tokens.push({ t: m, c: "sql-str" });
    else if (/^\d+$/.test(m)) tokens.push({ t: m, c: "sql-num" });
    else tokens.push({ t: m, c: "sql-kw" });
    i = off + m.length;
    return m;
  });
  if (i < sql.length) tokens.push({ t: sql.slice(i) });
  return tokens.map((tk, idx) =>
    tk.c ? (
      <span key={idx} className={tk.c}>
        {tk.t}
      </span>
    ) : (
      <Fragment key={idx}>{tk.t}</Fragment>
    ),
  );
}
