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
  // Poora VALUES list nikalo (multi-row tuple support): tuple1 ke `(` se lekar
  // aakhiri tuple ke `)` tak, top-level `, (...)` ke saath.
  let i = openIdx;
  let depth = 0;
  let valuesEnd = -1;
  let inStr = false;
  while (i < head.length) {
    const ch = head[i];
    if (inStr) {
      if (ch === "'") {
        if (head[i + 1] === "'") i++;
        else inStr = false;
      }
      i++;
      continue;
    }
    if (ch === "'") inStr = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        const m = /^\s*,\s*\(/.exec(head.slice(i + 1));
        if (m) {
          i = i + 1 + m[0].indexOf('('); // agle tuple ka '('
          depth = 1;
          i++;
          continue;
        }
        valuesEnd = i + 1;
        break;
      }
    }
    i++;
  }
  if (valuesEnd < 0) throw new Error('translate: unbalanced VALUES list');
  const valuesList = head.slice(openIdx, valuesEnd);
  if (head.slice(valuesEnd).trim() !== '') {
    throw new Error('translate: unexpected text between VALUES and ON CONFLICT');
  }
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
  // (`ins.index` already points at the "INSERT ..." keyword — do not add a
  // second one, that emits "INSERT INSERT INTO ..." which is a syntax error.)
  if (!target.length && isNothing && returningCols === null) {
    return (
      `${prefix}BEGIN TRY\n  ${head.slice(ins.index).trim()};\nEND TRY\n` +
      'BEGIN CATCH\n  IF ERROR_NUMBER() NOT IN (2601, 2627) THROW;\nEND CATCH'
    );
  }
  if (!target.length) throw new Error('translate: ON CONFLICT without target column');

  const onConds = target.map((c) => `tgt.${quoteIdent(c)} = src.${quoteIdent(c)}`).join(' AND ');
  const srcCols = cols.map(quoteIdent).join(', ');
  const insertVals = cols.map((c) => `src.${quoteIdent(c)}`).join(', ');

  const lines = [`MERGE ${table} WITH (HOLDLOCK) AS tgt`];
  lines.push(`USING (VALUES ${valuesList}) AS src (${srcCols})`);
  lines.push(`ON ${onConds}`);
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

  const stmt = lines.join('\n');

  // MERGE ka OUTPUT clause WHEN clauses ke BAAD aata hai (INSERT/UPDATE/DELETE
  // ke ulta) — pehle rakhne par syntax error 102. Aur RETURNING ke liye
  // trigger-safe capture bhi chahiye (error 334) — dono yahin hote hain.
  if (returningCols !== null) {
    const parsed = parseReturningCols(returningCols);
    const tmp = `#r${fnv1a(sql)}`;
    return prefix + captureViaTemp(table, tmp, `${stmt}\nOUTPUT INSERTED.* INTO ${tmp}`, parsed);
  }
  return prefix + `${stmt};`;
}

// --------------------------------------------------- RETURNING -> OUTPUT clause
// RETURNING list: `*` ya bare columns (optional AS alias). Output clause me
// hamesha `INSERTED.*`/`DELETED.*` jata hai (temp table me saare columns),
// isliye items sirf final SELECT projection ke liye chahiye.
function parseReturningCols(cols) {
  const trimmed = cols.trim();
  if (trimmed === '*') return { star: true, items: [] };
  const items = splitTopLevel(trimmed).map((raw) => {
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
    return { bare, alias };
  });
  return { star: false, items };
}

function returningSelectList(parsed) {
  if (parsed.star) return '*';
  return parsed.items
    .map((c) => `${quoteIdent(c.bare)}${c.alias ? ` AS ${c.alias}` : ''}`)
    .join(', ');
}

// Deterministic temp-table name (same SQL -> same name; DROP IF EXISTS makes
// it safe to reuse across pooled connections and repeated calls).
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// Trigger-safe OUTPUT capture. SQL Server error 334: OUTPUT-without-INTO is
// illegal on a DML target that has enabled triggers — and db/mssql/001_schema.sql
// enables trg_bookings_* / trg_ratings_* for PG parity, so a plain
// `INSERT ... OUTPUT INSERTED.x VALUES (...)` fails on the first booking.
// Redirect the OUTPUT into a temp table and let the caller read the row from
// a final SELECT. The temp is built through a UNION ALL because a plain
// SELECT INTO copies the identity property, which OUTPUT INTO then refuses
// (IDENTITY_INSERT + explicit column list would be needed — column names are
// not known to this pure translator). Verified on SQLEXPRESS 2022: INSERT/
// UPDATE/DELETE/MERGE + triggered tables.
function captureViaTemp(table, tmp, dml, parsed) {
  return [
    `DROP TABLE IF EXISTS ${tmp};`,
    `SELECT TOP 0 * INTO ${tmp} FROM (SELECT * FROM ${table} WHERE 1 = 0 UNION ALL SELECT * FROM ${table} WHERE 1 = 0) AS __capture_src;`,
    `${dml.replace(/;\s*$/, '')};`,
    `SELECT ${returningSelectList(parsed)} FROM ${tmp};`,
    `DROP TABLE IF EXISTS ${tmp};`,
  ].join('\n');
}

function rewriteReturning(sql) {
  const hit = findOutsideLiterals(sql, /\sRETURNING\s+/);
  if (!hit) return sql;

  const before = sql.slice(0, hit.index);
  const fullCols = sql.slice(hit.index + hit.match[0].length);
  const cols = fullCols.replace(/;\s*$/, '').trim();
  const trimmedBefore = before.trimStart();

  let source = 'INSERTED';
  let insertAt;
  let table;

  if (/^INSERT\s+INTO\b/i.test(trimmedBefore)) {
    const tbl = /^INSERT\s+INTO\s+(\w+)/i.exec(trimmedBefore);
    if (!tbl) throw new Error('translate: INSERT..RETURNING target not found');
    table = tbl[1];
    const vIdx = /\sVALUES\s*\(/i.exec(before);
    if (!vIdx) throw new Error('translate: INSERT..RETURNING without VALUES');
    insertAt = before.indexOf('VALUES', vIdx.index);
  } else if (/^UPDATE\b/i.test(trimmedBefore)) {
    const tbl = /^UPDATE\s+(\w+)/i.exec(trimmedBefore);
    if (!tbl) throw new Error('translate: UPDATE..RETURNING target not found');
    table = tbl[1];
    insertAt = topLevelFirst(before, /\s(?:WHERE|FROM)\s+/i);
    if (insertAt < 0) throw new Error('translate: UPDATE..RETURNING without WHERE/FROM');
  } else if (/^DELETE\s+FROM\b/i.test(trimmedBefore)) {
    source = 'DELETED';
    const tbl = /^DELETE\s+FROM\s+(\w+)/i.exec(trimmedBefore);
    if (!tbl) throw new Error('translate: DELETE..RETURNING target not found');
    table = tbl[1];
    insertAt = topLevelFirst(before, /\sWHERE\s+/i);
    if (insertAt < 0) throw new Error('translate: DELETE..RETURNING without WHERE');
  } else {
    throw new Error('translate: RETURNING on unsupported statement shape');
  }

  const parsed = parseReturningCols(cols);
  const head = before.slice(0, insertAt).replace(/\s+$/, '');
  const tail = before.slice(insertAt).replace(/^\s+/, '');
  const tmp = `#r${fnv1a(sql)}`;
  return captureViaTemp(table, tmp, `${head} OUTPUT ${source}.* INTO ${tmp} ${tail}`, parsed);
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

// ------------------------------------------- 4b. LATERAL -> APPLY
// PG:   [LEFT|INNER] JOIN LATERAL (sub) alias ON TRUE
// T-SQL: [OUTER|CROSS] APPLY (sub) alias   — APPLY me ON clause nahi hota,
// aur `LATERAL` keyword hi nahi hai (error 156/102).
function rewriteLateral(sql) {
  let s = sql;
  for (let guard = 0; guard < 20; guard++) {
    const hit = findOutsideLiterals(s, /\b(?:LEFT|RIGHT|INNER|FULL)?\s*JOIN\s+LATERAL\s*/i);
    if (!hit) break;
    const start = hit.index;
    const kw = hit.match[0].toLowerCase();
    const outer = /\b(left|right|inner|full)\b/.test(kw);
    const applyKw = outer ? 'OUTER APPLY' : 'CROSS APPLY';

    let open = start + hit.match[0].length;
    while (open < s.length && /\s/.test(s[open])) open++;
    if (s[open] !== '(') break; // not a subquery — leave as-is
    const close = afterBalanced(s, open); // index just past ')'
    const aliasM = /^\s*([A-Za-z_][\w$]*)/.exec(s.slice(close));
    if (!aliasM) break;
    const aliasEnd = close + aliasM[0].length;
    const alias = aliasM[1] ? ` ${aliasM[1]}` : '';

    // Optional `ON <cond>` ko poora hata do (APPLY ke paas ON nahi hota).
    let end = aliasEnd;
    const onM = /^\s*ON\s+/i.exec(s.slice(aliasEnd));
    if (onM) {
      const condStart = aliasEnd + onM[0].length;
      let j = condStart;
      let depth = 0;
      while (j < s.length) {
        const ch = s[j];
        if (ch === '(') depth++;
        else if (ch === ')') {
          if (depth === 0) break;
          depth--;
        } else if (depth === 0) {
          if (ch === ',' || ch === ';') break;
          if (/\s/.test(ch)) {
            const stop =
              /^\s*(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION|LEFT|RIGHT|INNER|FULL|CROSS|JOIN)\b/i.exec(
                s.slice(j),
              );
            if (stop) break;
          }
        }
        j++;
      }
      end = j;
      while (end > condStart && /\s/.test(s[end - 1])) end--;
    }
    const repl = `${applyKw} ${s.slice(open, close)}${alias}`;
    s = s.slice(0, start) + repl + s.slice(end);
  }
  return s;
}

// ---------------------------------------- 4c. ORDER BY ... NULLS FIRST/LAST
// MSSQL ko `NULLS LAST` syntax hi nahi milta (error 102). PG parity ke liye
// null-flag ko pehla sort key bana do: non-nulls pehle (ASC) / nulls last.
function rewriteNullsOrder(sql) {
  return outsideLiterals(sql, (s0) => {
    let s = s0;
    for (let guard = 0; guard < 40; guard++) {
      const m = /\bNULLS\s+(FIRST|LAST)\b/i.exec(s);
      if (!m) break;
      const nullsFirst = m[1].toUpperCase() === 'FIRST';

      // item ka start: depth-0 ',' ya `ORDER BY` tak peechhe jao.
      const lower = s.toLowerCase();
      let itemStart = -1;
      let depth = 0;
      for (let i = m.index - 1; i >= 0; i--) {
        const ch = s[i];
        if (ch === ')') depth++;
        else if (ch === '(') {
          if (depth === 0) break; // subquery/func ke andar — yahi item boundary
          depth--;
        } else if (ch === ',' && depth === 0) {
          itemStart = i + 1;
          break;
        }
        if (depth === 0 && endsWithWord(lower, i, 'order by')) {
          itemStart = i + 'order by'.length;
          break;
        }
      }
      if (itemStart < 0) itemStart = 0;
      const item = s.slice(itemStart, m.index).replace(/\s+$/, '');
      const dirM = /\s+(ASC|DESC)$/i.exec(item);
      const dir = dirM ? dirM[1].toUpperCase() : 'ASC';
      const expr = (dirM ? item.slice(0, dirM.index) : item).trim();
      if (!expr) break;

      const isDesc = dir === 'DESC';
      const flag = nullsFirst === isDesc ? 1 : 0;
      const repl = ` CASE WHEN ${expr} IS NULL THEN ${flag} ELSE ${1 - flag} END, ${expr} ${dir}`;
      s = s.slice(0, itemStart) + repl + s.slice(m.index + m[0].length);
    }
    return s;
  });
}

// ------------------------------- 4d. GROUP BY PK -> PG functional dependency
// PG: `GROUP BY d.id` (PK) ke saath `d.name` select/ORDER BY me chalta hai
// (functional dependency). MSSQL ko error 8120 milta hai. Simple
// `alias.col` items ko GROUP BY me add kar do — PG parity safe hai, kyunki
// aisa query PG me tabhi chalta hai jab GROUP BY us table ka PK ho.
function rewriteGroupBy(sql) {
  return outsideLiterals(sql, (s0) => {
    let s = s0;
    const gbIdx = [];
    const gRe = /\bGROUP\s+BY\b/gi;
    let g;
    while ((g = gRe.exec(s))) gbIdx.push(g.index);

    const isSimpleCol = (x) => /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(x);
    const baseOf = (x) => (x.includes('.') ? x.slice(x.lastIndexOf('.') + 1) : x);

    for (let k = gbIdx.length - 1; k >= 0; k--) {
      const gbAt = gbIdx[k];
      const listStart = gbAt + /^GROUP\s+BY/i.exec(s.slice(gbAt))[0].length;

      // GROUP BY list ka ant: depth-0 par HAVING/ORDER/LIMIT/OFFSET/UNION/) /;
      let listEnd = -1;
      let depth = 0;
      const lower = s.toLowerCase();
      for (let i = listStart; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
          if (depth === 0) {
            listEnd = i;
            break;
          }
          depth--;
        } else if (depth === 0) {
          if (ch === ';' ) {
            listEnd = i;
            break;
          }
          if (/\s/.test(ch)) {
            const stop =
              /^\s*(?:HAVING|ORDER\s+BY|LIMIT|OFFSET|UNION|FOR)\b/i.exec(s.slice(i));
            if (stop) {
              listEnd = i;
              break;
            }
          }
        }
      }
      if (listEnd < 0) listEnd = s.length;
      while (listEnd > listStart && /\s/.test(s[listEnd - 1])) listEnd--;
      const groupText = s.slice(listStart, listEnd);
      const groupItems = splitTopLevel(groupText)
        .map((x) => x.replace(/\s+(?:ASC|DESC)$/i, '').trim().toLowerCase())
        .filter(Boolean);
      if (!groupItems.length) continue;

      // Nearest SELECT (depth-0, backward) — wahi rewriteLimit wala scan.
      const prefix = s.slice(0, gbAt);
      let bDepth = 0;
      let selectAt = -1;
      for (let i = prefix.length - 1; i >= 0; i--) {
        const ch = prefix[i];
        if (ch === ')') bDepth++;
        else if (ch === '(') {
          if (bDepth === 0) break;
          bDepth--;
        }
        if (bDepth === 0 && endsWithWord(lower, i, 'select')) {
          selectAt = i;
          break;
        }
      }
      if (selectAt < 0) continue;

      // SELECT list ka ant: depth-0 FROM.
      let fromAt = -1;
      let fDepth = 0;
      for (let i = selectAt; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(') fDepth++;
        else if (ch === ')') {
          if (fDepth === 0) break;
          fDepth--;
        } else if (fDepth === 0 && endsWithWord(lower, i, 'from')) {
          fromAt = i;
          break;
        }
      }
      if (fromAt < 0) continue;
      let selStart = selectAt + /^select/i.exec(s.slice(selectAt))[0].length;
      const distM = /^\s+DISTINCT\b/i.exec(s.slice(selStart));
      if (distM) continue; // DISTINCT semantics — chhod do jaise hai
      while (selStart < fromAt && /\s/.test(s[selStart])) selStart++;

      // ORDER BY list (GROUP BY ke baad, depth-0) — ORDER BY me bhi simple
      // columns PG functional dependency se chalte hain, MSSQL ko chahiye.
      let orderStart = -1;
      let orderEnd = -1;
      {
        let d = 0;
        let i = listEnd;
        for (; i < s.length; i++) {
          const c = s[i];
          if (c === '(') d++;
          else if (c === ')') {
            if (d === 0) break;
            d--;
          } else if (d === 0) {
            if (c === ';') break;
            if (endsWithWord(lower, i, 'order by')) {
              orderStart = i + 'order by'.length;
              break;
            }
          }
        }
        if (orderStart >= 0) {
          orderEnd = s.length;
          d = 0;
          for (let j = orderStart; j < s.length; j++) {
            const c = s[j];
            if (c === '(') d++;
            else if (c === ')') {
              if (d === 0) {
                orderEnd = j;
                break;
              }
              d--;
            } else if (d === 0 && c === ';') {
              orderEnd = j;
              break;
            } else if (d === 0 && /\s/.test(c)) {
              const stop = /^\s*(?:LIMIT|OFFSET|FETCH|UNION|FOR)\b/i.exec(s.slice(j));
              if (stop) {
                orderEnd = j;
                break;
              }
            }
          }
          while (orderEnd > orderStart && /\s/.test(s[orderEnd - 1])) orderEnd--;
        }
      }

      const wanted = new Set(groupItems);
      const additions = [];
      const consider = (raw) => {
        const noDir = raw.replace(/\s+(?:ASC|DESC)$/i, '').trim();
        if (!noDir) return;
        const aliasM = /\s+AS\s+[A-Za-z_]\w*$/i.exec(noDir);
        const expr = (aliasM ? noDir.slice(0, aliasM.index) : noDir).trim();
        if (!expr || expr.includes('(')) return; // aggregate/subquery/func — skip
        const low = expr.toLowerCase();
        if (wanted.has(low)) return;
        if (!isSimpleCol(expr)) {
          // bare ident: sirf tab maan lo agar GROUP BY me wahi column ho
          if (/^[A-Za-z_]\w*$/.test(low)) {
            const hit = groupItems.some((gi) => gi === low || gi.endsWith('.' + low));
            if (hit) return;
          }
          return;
        }
        const col = baseOf(low);
        const hit = groupItems.some((gi) => gi === low || gi.endsWith('.' + col));
        if (hit) return;
        wanted.add(low);
        additions.push(expr);
      };

      for (const item of splitTopLevel(s.slice(selStart, fromAt))) consider(item);
      if (orderStart >= 0) for (const item of splitTopLevel(s.slice(orderStart, orderEnd)))
        consider(item);

      if (additions.length) {
        s = `${s.slice(0, listEnd)}, ${additions.join(', ')}${s.slice(listEnd)}`;
      }
    }
    return s;
  });
}

// ------------------------- 4e. aggregate over scalar subquery -> CROSS APPLY
// PG: `SUM((SELECT COALESCE(SUM(x), 0) FROM o WHERE o.k = p.id))` chalta hai;
// MSSQL error 130 deta hai ("aggregate ... containing an aggregate or a
// subquery"). Subquery ko CROSS APPLY me le jao, aggregate uske column par.
function parenDepthAt(s, end) {
  let d = 0;
  let inStr = false;
  for (let i = 0; i < end; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "'") {
        if (s[i + 1] === "'") i++;
        else inStr = false;
      }
      continue;
    }
    if (ch === "'") inStr = true;
    else if (ch === '(') d++;
    else if (ch === ')') d--;
  }
  return d;
}

function rewriteAggregateSubquery(sql) {
  let s = sql;
  for (let guard = 0; guard < 20; guard++) {
    const hit = findOutsideLiterals(s, /\b(SUM|COUNT|AVG|MIN|MAX)\s*\(\s*\(/i);
    if (!hit) break;
    const aggStart = hit.index;
    const aggName = hit.match[1].toUpperCase();
    const open1 = aggStart + hit.match[0].indexOf('(');
    let p = open1 + 1;
    while (p < s.length && /\s/.test(s[p])) p++;
    if (s[p] !== '(') break;
    const open2 = p;
    if (!/^\s*SELECT\b/i.test(s.slice(open2 + 1))) break;
    let close1;
    let close2;
    try {
      close1 = afterBalanced(s, open1);
      close2 = afterBalanced(s, open2);
    } catch {
      break;
    }
    if (close2 !== close1 - 1) break; // `AGG((SELECT ..))` shape hi chahiye
    const sub = s.slice(open2 + 1, close2 - 1);

    // Enclosing query ka SELECT dhoondho (depth-0 par, `;` tak).
    const lower = s.toLowerCase();
    let qSelect = -1;
    let d = 0;
    for (let i = aggStart - 1; i >= 0; i--) {
      const ch = s[i];
      if (ch === ';') {
        if (d === 0) break;
        continue;
      }
      if (ch === ')') {
        d++;
        continue;
      }
      if (ch === '(') {
        if (d > 0) d--;
        continue; // enclosing expression (COALESCE etc.) — aage jao
      }
      if (d === 0 && endsWithWord(lower, i, 'select')) {
        qSelect = i;
        break;
      }
    }
    if (qSelect < 0) break;
    const q = parenDepthAt(s, qSelect);

    const alias = `__asq${guard}${fnv1a(sub).slice(0, 5)}`;
    const repl = `${aggName}(${alias}.v)`;
    s = s.slice(0, aggStart) + repl + s.slice(close1);
    const scanStart = aggStart + repl.length;

    // Injection point: enclosing query ke body level (q) par WHERE/ORDER/
    // GROUP/LIMIT/`;`/`)` — uske theek pehle CROSS APPLY jod do.
    let depth = parenDepthAt(s, scanStart);
    let inj = -1;
    let inStr = false;
    for (let i = scanStart; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (ch === "'") {
          if (s[i + 1] === "'") i++;
          else inStr = false;
        }
        continue;
      }
      if (ch === "'") inStr = true;
      else if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === q) {
          inj = i;
          break;
        }
        depth--;
      } else if (depth === q) {
        if (ch === ';') {
          inj = i;
          break;
        }
        if (/\s/.test(ch)) {
          const stop =
            /^\s*(?:WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|FETCH|UNION|FOR)\b/i.exec(
              s.slice(i),
            );
          if (stop) {
            inj = i;
            break;
          }
        }
      }
    }
    if (inj < 0) inj = s.length;
    while (inj > scanStart && /\s/.test(s[inj - 1])) inj--;

    // Subquery ko column alias do (top-level FROM ke pehle ` AS v`).
    let inner;
    let fIdx = -1;
    let fd = 0;
    let inStr2 = false;
    const subLower = sub.toLowerCase();
    for (let i = 0; i < sub.length; i++) {
      const ch = sub[i];
      if (inStr2) {
        if (ch === "'") {
          if (sub[i + 1] === "'") i++;
          else inStr2 = false;
        }
        continue;
      }
      if (ch === "'") inStr2 = true;
      else if (ch === '(') fd++;
      else if (ch === ')') fd--;
      else if (fd === 0 && endsWithWord(subLower, i, 'from')) {
        fIdx = i;
        break;
      }
    }
    if (fIdx >= 0) {
      let fs = fIdx;
      while (fs > 0 && /\s/.test(sub[fs - 1])) fs--;
      inner = `${sub.slice(0, fs)} AS v ${sub.slice(fs)}`;
    } else {
      inner = `${sub.trim().replace(/;$/, '')} AS v`;
    }
    s = `${s.slice(0, inj)} CROSS APPLY (${inner}) AS ${alias}${s.slice(inj)}`;
  }
  return s;
}

// ------------------------------------------------------------- 5. = ANY($n)
function rewriteAny(sql) {
  return sql.replace(
    /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*=\s*ANY\((@p\d+)\)/g,
    (_, col, p) => `${col} IN (SELECT TRY_CAST(value AS UNIQUEIDENTIFIER) FROM OPENJSON(${p}))`,
  );
}

// ------------------------------------------ 5b. bare boolean params
// T-SQL BIT params ko boolean context me use nahi kar sakte —
// `CASE WHEN @p1 THEN ..` PG me valid hai, MSSQL me error 4145
// ("non-boolean type ... near 'THEN'"). Sirf `@pN` params par lagta hai
// (bare columns/`(` contexts me false-positive khatarnaak hai — column
// lists, VALUES, function args sab `(` se shuru hote hain).
function rewriteBoolean(sql) {
  return outsideLiterals(sql, (s) =>
    s.replace(
      /((?:\bWHERE\b|\bAND\b|\bOR\b|\bWHEN\b|\bNOT\b)\s*)(@p\d+)(?=\s*(?:\bTHEN\b|\bAND\b|\bOR\b|[),;]|$))/g,
      (_, pre, expr) => `${pre}${expr} = 1`,
    ),
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
  s = rewriteLateral(s);
  s = rewriteNullsOrder(s);
  s = rewriteOnConflict(s);
  s = rewriteReturning(s);
  s = rewriteLimit(s);
  s = rewriteAggregateSubquery(s);
  s = rewriteAny(s);
  s = rewriteForUpdate(s);
  s = rewriteFilter(s);
  s = rewriteGroupBy(s);
  s = rewriteMakeInterval(s);
  s = rewriteIntervalNow(s);
  s = rewriteToChar(s);
  s = rewriteDateTrunc(s);
  s = rewriteIlike(s);
  s = rewriteBoolean(s);
  s = rewriteKeyIdent(s);
  s = rewriteTrueFalse(s);
  return s;
}
