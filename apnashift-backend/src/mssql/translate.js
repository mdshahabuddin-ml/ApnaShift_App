// PostgreSQL -> T-SQL translator, scoped to the exact SQL shapes this
// codebase emits (see tests/translate.test.js for the per-shape contract).
// Runs ONLY on the mssql driver path (src/db.js); the pg path never sees it.
//
// Rules:
// - Keyword rewrites skip single-quoted literals ('' escapes supported).
// - Structural rewrites (RETURNING/ON CONFLICT/INTERVAL) match full patterns
//   that include their literals — only fixed literals ever appear there.
// - Unsupported shapes must THROW — silent wrong SQL is worse than a crash.
// - Never log translated SQL from here (may contain phones/hashes).

// ---------------------------------------------------------------- literals
// Segments are either code or PROTECTED text (single-quoted literals and
// `-- line comments`); protected segments are skipped by keyword rewrites.
function splitLiterals(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      if (buf) out.push({ lit: false, text: buf });
      buf = "'";
      i++;
      while (i < sql.length) {
        buf += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            buf += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out.push({ lit: true, text: buf });
      buf = '';
    } else if (ch === '-' && sql[i + 1] === '-') {
      if (buf) out.push({ lit: false, text: buf });
      buf = '';
      while (i < sql.length && sql[i] !== '\n') {
        buf += sql[i];
        i++;
      }
      out.push({ lit: true, text: buf });
      buf = '';
    } else {
      buf += ch;
      i++;
    }
  }
  if (buf) out.push({ lit: false, text: buf });
  return out;
}

// Apply fn only to non-literal segments (keyword-level rewrites).
function outsideLiterals(sql, fn) {
  return splitLiterals(sql)
    .map((s) => (s.lit ? s.text : fn(s.text)))
    .join('');
}

// {index, match} of first `re` hit outside literals (index is global).
function findOutsideLiterals(sql, re) {
  let offset = 0;
  for (const seg of splitLiterals(sql)) {
    if (!seg.lit) {
      const m = re.exec(seg.text);
      if (m) return { index: offset + m.index, match: m };
    }
    offset += seg.text.length;
  }
  return null;
}

// ------------------------------------------------------------- scan helpers
function afterBalanced(sql, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('translate: unbalanced () forward from ' + openIdx);
}

function beforeBalanced(sql, end) {
  let depth = 0;
  for (let i = end - 1; i >= 0; i--) {
    if (sql[i] === ')') depth++;
    else if (sql[i] === '(') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('translate: unbalanced () backward from ' + end);
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let cur = '';
  let inLit = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inLit) {
      cur += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") {
          cur += text[++i];
        } else {
          inLit = false;
        }
      }
      continue;
    }
    if (ch === "'") inLit = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function quoteIdent(name) {
  const n = name.trim();
  return n.toLowerCase() === 'key' ? '[key]' : n;
}

// First index in `s` where `re` matches at paren-depth 0 (for OUTPUT placement).
function topLevelFirst(s, re) {
  let depth = 0;
  let inLit = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inLit) {
      if (ch === "'") inLit = false;
      continue;
    }
    if (ch === "'") {
      inLit = true;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0) {
      const m = re.exec(s.slice(i));
      if (m && m.index === 0) return i;
    }
  }
  return -1;
}

const CAST_TYPES = {
  int: 'INT',
  integer: 'INT',
  bigint: 'BIGINT',
  smallint: 'SMALLINT',
  tinyint: 'TINYINT',
  text: 'NVARCHAR(MAX)',
  jsonb: 'NVARCHAR(MAX)',
  json: 'NVARCHAR(MAX)',
  varchar: 'NVARCHAR(4000)',
  char: 'CHAR(1)',
  bpchar: 'CHAR(1)',
  numeric: 'DECIMAL(38, 10)',
  decimal: 'DECIMAL(38, 10)',
  real: 'REAL',
  float: 'FLOAT',
  double: 'FLOAT',
  bool: 'BIT',
  boolean: 'BIT',
  date: 'DATE',
  timestamp: 'DATETIME2',
  timestamptz: 'DATETIMEOFFSET',
  uuid: 'UNIQUEIDENTIFIER',
  money: 'DECIMAL(19, 4)',
};

function castTo(pgType) {
  const mapped = CAST_TYPES[pgType.toLowerCase()];
  if (!mapped) throw new Error('translate: unsupported cast ::' + pgType);
  return mapped;
}

// ------------------------------------------------------------- 1. $n -> @pn
function rewriteParams(sql) {
  return outsideLiterals(sql, (s) => s.replace(/\$(\d+)/g, (_, n) => '@p' + n));
}

// ------------------------------------------------------------- 2. :: casts
function rewriteCasts(sql) {
  let s = sql.replace(/(\w+\([^()]*\))\s*::\s*(\w+)/g, (m, expr, t) => `CAST(${expr} AS ${castTo(t)})`);
  s = s.replace(/([@$][\w]+|[\w.]+)\s*::\s*(\w+)/g, (m, expr, t) => `CAST(${expr} AS ${castTo(t)})`);
  return s;
}

// --------------------------------------------------- 3. ON CONFLICT -> MERGE
function rewriteOnConflict(sql) {
  const hit = findOutsideLiterals(sql, /\sON CONFLICT\b/);
  if (!hit) return sql;

  const head = sql.slice(0, hit.index);
  const rest = sql.slice(hit.index);

  const ins = /INSERT\s+INTO\s+(\w+)\s*\(([\s\S]*?)\)\s*VALUES\s*\(/i.exec(head);
  if (!ins) throw new Error('translate: ON CONFLICT on non INSERT..VALUES shape');
  const table = ins[1];
  const cols = splitTopLevel(ins[2]);
  const kwIdx = head.lastIndexOf('VALUES');
  const openIdx = head.indexOf('(', kwIdx);
  const valuesEnd = afterBalanced(head, openIdx);
  if (head.slice(valuesEnd).trim() !== '') {
    throw new Error('translate: unexpected text between VALUES and ON CONFLICT');
  }
  const valuesInner = head.slice(openIdx + 1, valuesEnd - 1);
  const prefix = head.slice(0, ins.index);

  let body = rest.replace(/^\s*ON CONFLICT\b/i, '').replace(/^\s*/, '');

  let target = [];
  if (body.startsWith('(')) {
    const end = afterBalanced(body, 0);
    target = splitTopLevel(body.slice(1, end - 1));
    body = body.slice(end).replace(/^\s*/, '');
  }

  let returningCols = null;
  const retHit = /\sRETURNING\s+/i.exec(body);
  if (retHit) {
    returningCols = body.slice(retHit.index + retHit[0].length).trim().replace(/;\s*$/, '');
    body = body.slice(0, retHit.index);
  }
  body = body.replace(/;\s*$/, '').trim();

  const isNothing = /^DO\s+NOTHING$/i.test(body);
  let updateSet = null;
  if (!isNothing) {
    const up = /^DO\s+UPDATE\s+SET\s+/i.exec(body);
    if (!up) throw new Error('translate: unsupported ON CONFLICT tail');
    updateSet = splitTopLevel(body.slice(up[0].length));
  }

  // Targetless DO NOTHING: swallow duplicate-key errors around the INSERT.
  if (!target.length && isNothing && returningCols === null) {
    return (
      `${prefix}BEGIN TRY\n  INSERT ${head.slice(ins.index).trim()}\nEND TRY\n` +
      'BEGIN CATCH\n  IF ERROR_NUMBER() NOT IN (2601, 2627) THROW;\nEND CATCH'
    );
  }
  if (!target.length) throw new Error('translate: ON CONFLICT without target column');

  const onConds = target.map((c) => `tgt.${quoteIdent(c)} = src.${quoteIdent(c)}`).join(' AND ');
  const srcCols = cols.map(quoteIdent).join(', ');
  const insertVals = cols.map((c) => `src.${quoteIdent(c)}`).join(', ');

  const lines = [`MERGE ${table} WITH (HOLDLOCK) AS tgt`];
  lines.push(`USING (VALUES (${valuesInner})) AS src (${srcCols})`);
  lines.push(`ON ${onConds}`);
  if (returningCols !== null) lines.push(`OUTPUT ${outputSpec(returningCols, 'INSERTED')}`);
  if (updateSet) {
    const sets = updateSet.map((s) => {
      const eq = s.indexOf('=');
      if (eq < 0) throw new Error('translate: bad ON CONFLICT SET clause');
      const col = s.slice(0, eq).trim();
      const val = s
        .slice(eq + 1)
        .trim()
        .replace(/\bEXCLUDED\.(\w+)/gi, 'src.$1');
      return `${quoteIdent(col)} = ${val}`;
    });
    lines.push(`WHEN MATCHED THEN UPDATE SET ${sets.join(', ')}`);
  }
  lines.push(`WHEN NOT MATCHED THEN INSERT (${srcCols}) VALUES (${insertVals})`);
  lines.push(';');

  return prefix + lines.join('\n');
}

// --------------------------------------------------- RETURNING -> OUTPUT clause
function outputSpec(cols, source) {
  const trimmed = cols.trim();
  if (trimmed === '*') return `${source}.*`;
  return splitTopLevel(trimmed)
    .map((raw) => {
      let item = raw.trim();
      let alias = null;
      const asIdx = /\s+AS\s+([\w"]+)\s*$/i.exec(item);
      if (asIdx) {
        alias = asIdx[1];
        item = item.slice(0, asIdx.index).trim();
      }
      const bare = item.includes('.') ? item.slice(item.lastIndexOf('.') + 1) : item;
      if (!/^[A-Za-z_][\w]*$/.test(bare)) {
        throw new Error('translate: unsupported RETURNING expression: ' + raw);
      }
      return `${source}.${bare}${alias ? ` AS ${alias}` : ''}`;
    })
    .join(', ');
}

function rewriteReturning(sql) {
  const hit = findOutsideLiterals(sql, /\sRETURNING\s+/);
  if (!hit) return sql;

  const before = sql.slice(0, hit.index);
  const fullCols = sql.slice(hit.index + hit.match[0].length);
  const trailing = (fullCols.match(/;\s*$/) ?? [''])[0];
  const cols = fullCols.replace(/;\s*$/, '').trim();
  const trimmedBefore = before.trimStart();

  let source = 'INSERTED';
  let insertAt;

  if (/^INSERT\s+INTO\b/i.test(trimmedBefore)) {
    const vIdx = /\sVALUES\s*\(/i.exec(before);
    if (!vIdx) throw new Error('translate: INSERT..RETURNING without VALUES');
    insertAt = before.indexOf('VALUES', vIdx.index);
  } else if (/^UPDATE\b/i.test(trimmedBefore)) {
    insertAt = topLevelFirst(before, /\s(?:WHERE|FROM)\s+/i);
    if (insertAt < 0) throw new Error('translate: UPDATE..RETURNING without WHERE/FROM');
  } else if (/^DELETE\s+FROM\b/i.test(trimmedBefore)) {
    source = 'DELETED';
    insertAt = topLevelFirst(before, /\sWHERE\s+/i);
    if (insertAt < 0) throw new Error('translate: DELETE..RETURNING without WHERE');
  } else {
    throw new Error('translate: RETURNING on unsupported statement shape');
  }

  const spec = outputSpec(cols, source);
  const head = before.slice(0, insertAt).replace(/\s+$/, '');
  const tail = before.slice(insertAt).replace(/^\s+/, '');
  return `${head} OUTPUT ${spec} ${tail}${trailing}`;
}

// --------------------------------------------------------- 4. LIMIT/OFFSET
function endsWithWord(lowerStr, i, word) {
  if (!lowerStr.startsWith(word, i)) return false;
  const before = i === 0 ? ' ' : lowerStr[i - 1];
  const after = lowerStr[i + word.length] ?? ' ';
  const isWord = (c) => /[a-z0-9_]/.test(c);
  return !isWord(before) && !isWord(after);
}

function rewriteLimit(sql) {
  const matches = [];
  let offset = 0;
  for (const seg of splitLiterals(sql)) {
    if (!seg.lit) {
      const re = /LIMIT\s+(@p\d+|\d+)(?:\s+OFFSET\s+(@p\d+|\d+))?/gi;
      let m;
      while ((m = re.exec(seg.text))) {
        matches.push({ at: offset + m.index, len: m[0].length, lim: m[1], off: m[2] ?? null });
      }
    }
    offset += seg.text.length;
  }

  let s = sql;
  for (let k = matches.length - 1; k >= 0; k--) {
    const mt = matches[k];
    const prefix = s.slice(0, mt.at);
    const lower = prefix.toLowerCase();

    // Walk backward at the LIMIT's paren level; find nearest ORDER BY / SELECT.
    let depth = 0;
    let orderByAt = -1;
    let selectAt = -1;
    for (let i = prefix.length - 1; i >= 0; i--) {
      const ch = prefix[i];
      if (ch === ')') depth++;
      else if (ch === '(') {
        if (depth === 0) break; // left this paren level
        depth--;
      }
      if (depth === 0) {
        if (orderByAt < 0 && endsWithWord(lower, i, 'order by')) orderByAt = i;
        if (selectAt < 0 && endsWithWord(lower, i, 'select')) selectAt = i;
      }
    }

    if (orderByAt >= 0) {
      const repl = mt.off
        ? `OFFSET ${mt.off} ROWS FETCH NEXT ${mt.lim} ROWS ONLY`
        : `OFFSET 0 ROWS FETCH NEXT ${mt.lim} ROWS ONLY`;
      s = s.slice(0, mt.at) + repl + s.slice(mt.at + mt.len);
      shiftMatches(matches, k, mt.at, repl.length - mt.len);
    } else {
      if (selectAt < 0) throw new Error('translate: LIMIT without ORDER BY or SELECT');
      // Drop the LIMIT token plus the whitespace in front of it.
      let rmStart = mt.at;
      while (rmStart > 0 && /[ \t\r\n]/.test(s[rmStart - 1])) rmStart--;
      const rmLen = mt.at + mt.len - rmStart;
      s = s.slice(0, rmStart) + s.slice(rmStart + rmLen);
      shiftMatches(matches, k, rmStart, -rmLen);

      const selM = /^(\s*)SELECT\b/i.exec(s.slice(selectAt));
      if (!selM) throw new Error('translate: SELECT scan missed');
      let insertPos = selectAt + selM[0].length;
      const distM = /^\s+DISTINCT\b/i.exec(s.slice(insertPos));
      if (distM) insertPos += distM[0].length;
      const top = ` TOP ${mt.lim}`;
      s = s.slice(0, insertPos) + top + s.slice(insertPos);
      shiftMatches(matches, k, insertPos, top.length);
    }
  }
  return s;
}

function shiftMatches(matches, upTo, pos, delta) {
  if (!delta) return;
  for (let j = 0; j < upTo; j++) {
    if (matches[j].at > pos) matches[j].at += delta;
  }
}

// ------------------------------------------------------------- 5. = ANY($n)
function rewriteAny(sql) {
  return sql.replace(
    /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*=\s*ANY\((@p\d+)\)/g,
    (_, col, p) => `${col} IN (SELECT TRY_CAST(value AS UNIQUEIDENTIFIER) FROM OPENJSON(${p}))`,
  );
}

// --------------------------------------------------------- 6. FOR UPDATE lock
const NO_ALIAS =
  '(?!\\s*(?:WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|GROUP|ORDER|LIMIT|OFFSET|HAVING|UNION|FOR|AND|OR|SET|ON)\\b)';

function rewriteForUpdate(sql) {
  const hit = findOutsideLiterals(sql, /\s+FOR UPDATE(?: OF (\w+))?\s*;?\s*$/i);
  if (!hit) return sql;

  const alias = hit.match[1] ?? null;
  const before = sql.slice(0, hit.index);
  const after = sql.slice(hit.index + hit.match[0].length);

  const refRe = alias
    ? new RegExp(`(\\b(?:FROM|JOIN)\\s+[A-Za-z_]\\w*\\s+(?:AS\\s+)?)${alias}\\b`, 'i')
    : new RegExp(`\\bFROM\\s+[A-Za-z_]\\w*(?:\\s+(?:AS\\s+)?${NO_ALIAS}[A-Za-z_]\\w*)?`, 'i');
  if (!refRe.test(before)) throw new Error('translate: FOR UPDATE target not found');
  const s = before.replace(refRe, (m) => `${m} WITH (UPDLOCK, ROWLOCK)`);

  return (s + after).trimEnd();
}

// --------------------------------------------------------- 7. FILTER (WHERE)
function rewriteFilter(sql) {
  let s = sql;
  for (;;) {
    const hit = findOutsideLiterals(s, /\bFILTER\s*\(\s*WHERE\b/i);
    if (!hit) break;

    const closeIdx = s.lastIndexOf(')', hit.index);
    if (closeIdx < 0) throw new Error('translate: FILTER without aggregate');
    const openIdx = beforeBalanced(s, closeIdx + 1);
    const aggM = /([A-Z]+)\s*\(\s*$/i.exec(s.slice(0, openIdx + 1));
    if (!aggM || !/^(COUNT|SUM|MIN|MAX|AVG|STRING_AGG)$/i.test(aggM[1])) {
      throw new Error('translate: unsupported FILTER aggregate');
    }
    const agg = aggM[1].toUpperCase();
    const inner = s.slice(openIdx + 1, closeIdx);

    const kw = /\bWHERE\b/i.exec(s.slice(hit.index));
    const condStart = hit.index + kw.index + kw[0].length;
    const parenIdx = s.indexOf('(', hit.index);
    const condEnd = afterBalanced(s, parenIdx);
    const cond = s.slice(condStart, condEnd - 1).trim();

    const thenVal = agg === 'COUNT' ? '1' : inner;
    const repl = `(CASE WHEN ${cond} THEN ${thenVal} END)`;
    s = s.slice(0, openIdx) + repl + s.slice(condEnd);
  }
  return s;
}

// ------------------------------------------------------ 8. now() / INTERVAL
const DATEADD_UNITS = ['year', 'month', 'week', 'day', 'hour', 'minute', 'second'];

function toUnit(raw) {
  let unit = raw.toLowerCase();
  if (unit.endsWith('s')) unit = unit.slice(0, -1);
  if (!DATEADD_UNITS.includes(unit)) throw new Error('translate: unsupported date unit ' + raw);
  return unit;
}

function rewriteIntervalNow(sql) {
  let s = sql.replace(/\bnow\(\)\s*-\s*INTERVAL\s*'(\d+)\s*([a-z]+)'/gi, (_, n, unitRaw) => {
    const unit = toUnit(unitRaw);
    return `DATEADD(${unit}, -${Number(n)}, SYSUTCDATETIME())`;
  });
  s = s.replace(/\bnow\(\)/gi, 'SYSUTCDATETIME()');
  return s;
}

// -------------------------------- 8b. now() - make_interval(secs => X)
// PG: `now() - make_interval(secs => $1)` = X seconds ago. T-SQL me
// make_interval nahi hota — DATEADD(second, X, SYSUTCDATETIME()).
function rewriteMakeInterval(sql) {
  let s = sql.replace(
    /\bnow\(\)\s*-\s*make_interval\(secs\s*=>\s*([^)]+)\)/gi,
    (_, secs) => `DATEADD(second, ${secs.trim()}, SYSUTCDATETIME())`,
  );
  s = s.replace(
    /\bSYSUTCDATETIME\(\)\s*-\s*make_interval\(secs\s*=>\s*([^)]+)\)/gi,
    (_, secs) => `DATEADD(second, ${secs.trim()}, SYSUTCDATETIME())`,
  );
  if (/\bmake_interval\s*\(/i.test(s)) {
    throw new Error('translate: unsupported make_interval shape');
  }
  return s;
}

// --------------------------------------- 9. to_char(date_trunc(..)) buckets
function rewriteToChar(sql) {
  let bucketExpr = null;
  let s = sql.replace(
    /\bto_char\(\s*date_trunc\(\s*'(\w+)'\s*,\s*([\s\S]+?)\s+AT TIME ZONE\s+'UTC'\s*\)\s*,\s*'[^']*'\s*\)/g,
    (_, unitRaw, expr) => {
      const unit = toUnit(unitRaw);
      bucketExpr = `CONVERT(varchar(10), DATEADD(${unit}, DATEDIFF(${unit}, 0, ${expr.trim()}), 0), 126)`;
      return bucketExpr;
    },
  );
  if (bucketExpr && /\bGROUP\s+BY\s+bucket\b/i.test(s)) {
    s = s.replace(/\bGROUP\s+BY\s+bucket\b/i, `GROUP BY ${bucketExpr}`);
  }
  return s;
}

// ------------------------- 9b. bare date_trunc('unit', expr) -> DATETRUNC
// SQL Server 2022+ (compat 150+). to_char(date_trunc(... AT TIME ZONE)) ka
// form section 9 pehle kha chuka hota hai — yahan sirf bare form bachta hai.
function rewriteDateTrunc(sql) {
  let s = sql.replace(
    /\bdate_trunc\(\s*'(\w+)'\s*,\s*([^()]*(?:\([^()]*\))?[^()]*)\)/g,
    (_, unitRaw, expr) => `DATETRUNC(${toUnit(unitRaw)}, ${expr.trim()})`,
  );
  if (/\bdate_trunc\s*\(/i.test(s)) {
    throw new Error('translate: unsupported date_trunc shape');
  }
  return s;
}

// ------------------------------------------------------------- 10. ILIKE
function rewriteIlike(sql) {
  let s = sql.replace(
    /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s+ILIKE\s+(@p\d+)/g,
    (_, col, p) => `LOWER(${col}) LIKE LOWER(${p})`,
  );
  s = s.replace(/\bILIKE\b/g, 'LIKE');
  return s;
}

// ------------------------------------------------------- 11. bare `key` col
function rewriteKeyIdent(sql) {
  return outsideLiterals(
    sql,
    (s) =>
      s.replace(
        /(\bWHERE\s+|\bAND\s+|\bOR\s+|\bSET\s+|\bSELECT\s+|\bINTO\s+|\(|,)(\s*)key(\s*(?:=|,|\)))/gi,
        (_, pre, sp, post) => `${pre}${sp}[key]${post}`,
      ),
  );
}

// -------------------------------------------------------- 12. TRUE/FALSE
function rewriteTrueFalse(sql) {
  return outsideLiterals(sql, (s) => s.replace(/\bTRUE\b/g, '1').replace(/\bFALSE\b/g, '0'));
}

// ------------------------------------------------------------------- main
export function translateToMssql(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new Error('translate: empty sql');
  }
  let s = rewriteParams(sql);
  s = rewriteCasts(s);
  s = rewriteOnConflict(s);
  s = rewriteReturning(s);
  s = rewriteLimit(s);
  s = rewriteAny(s);
  s = rewriteForUpdate(s);
  s = rewriteFilter(s);
  s = rewriteMakeInterval(s);
  s = rewriteIntervalNow(s);
  s = rewriteToChar(s);
  s = rewriteDateTrunc(s);
  s = rewriteIlike(s);
  s = rewriteKeyIdent(s);
  s = rewriteTrueFalse(s);
  return s;
}
