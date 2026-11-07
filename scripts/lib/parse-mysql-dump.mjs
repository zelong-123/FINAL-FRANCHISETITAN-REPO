// Reads a mysqldump or phpMyAdmin SQL export without a MySQL server: table definitions,
// row values, AUTO_INCREMENT counters, and the time zone the export was written in.
// Values come back as strings or null, exactly as dumped; converting them is the importer's job.

/** Splits SQL into statements, ignoring semicolons inside strings, identifiers and comments. */
export function* splitStatements(sql) {
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipQuoted(sql, i);
    } else if (c === '-' && sql[i + 1] === '-' && (i + 2 >= n || /\s/.test(sql[i + 2]))) {
      const end = sql.indexOf('\n', i);
      if (sql.slice(start, i).trim() === '') start = end < 0 ? n : end + 1;
      i = end < 0 ? n : end + 1;
    } else if (c === '#') {
      const end = sql.indexOf('\n', i);
      if (sql.slice(start, i).trim() === '') start = end < 0 ? n : end + 1;
      i = end < 0 ? n : end + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new Error(`Unterminated comment at offset ${i}.`);
      // `/*!40103 SET ... */` is a statement to MySQL. Keep it so the time zone can be read.
      if (sql[i + 2] !== '!' && sql.slice(start, i).trim() === '') start = end + 2;
      i = end + 2;
    } else if (c === ';') {
      const text = sql.slice(start, i).trim();
      if (text) yield text;
      i += 1;
      start = i;
    } else {
      i += 1;
    }
  }
  const rest = sql.slice(start).trim();
  if (rest) yield rest;
}

function skipQuoted(sql, open) {
  const quote = sql[open];
  let i = open + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '\\' && quote !== '`') {
      i += 2;
    } else if (c === quote) {
      if (sql[i + 1] !== quote) return i + 1;
      i += 2;
    } else {
      i += 1;
    }
  }
  throw new Error(`Unterminated ${quote} string starting at offset ${open}.`);
}

const ESCAPES = { 0: '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a', '\\': '\\', "'": "'", '"': '"' };

function readString(text, open) {
  const quote = text[open];
  let out = '';
  let i = open + 1;
  let chunk = i;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      out += text.slice(chunk, i);
      const next = text[i + 1];
      // MySQL keeps the backslash in \% and \_; any other unknown escape is just the character.
      out += next === '%' || next === '_' ? `\\${next}` : ESCAPES[next] ?? next;
      i += 2;
      chunk = i;
    } else if (c === quote) {
      out += text.slice(chunk, i);
      if (text[i + 1] === quote) {
        out += quote;
        i += 2;
        chunk = i;
      } else {
        return { value: out, next: i + 1 };
      }
    } else {
      i += 1;
    }
  }
  throw new Error('Unterminated string in row values.');
}

const skipSpace = (text, i) => {
  let at = i;
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return at;
};

function readValue(text, start) {
  let i = start;
  if (text.startsWith('_binary', i)) i = skipSpace(text, i + 7);
  if (text[i] === "'" || text[i] === '"') return readString(text, i);
  const end = /[,)\s]/;
  let stop = i;
  while (stop < text.length && !end.test(text[stop])) stop += 1;
  const token = text.slice(i, stop);
  if (/^null$/i.test(token)) return { value: null, next: stop };
  if (/^true$/i.test(token)) return { value: '1', next: stop };
  if (/^false$/i.test(token)) return { value: '0', next: stop };
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(token)) return { value: token, next: stop };
  if (/^0x[0-9a-f]*$/i.test(token)) return { value: Buffer.from(token.slice(2), 'hex').toString('utf8'), next: stop };
  const bits = /^b'([01]*)'$/i.exec(token);
  if (bits) return { value: String(parseInt(bits[1] || '0', 2)), next: stop };
  throw new Error(`Unrecognised value near: ${text.slice(i, i + 40)}`);
}

/** Parses the `(a, b), (c, d)` part of an INSERT, from the offset of the first parenthesis. */
export function parseRows(text, start) {
  const rows = [];
  let i = skipSpace(text, start);
  while (i < text.length) {
    if (text[i] !== '(') throw new Error(`Expected a row near: ${text.slice(i, i + 40)}`);
    const row = [];
    i = skipSpace(text, i + 1);
    for (;;) {
      const { value, next } = readValue(text, i);
      row.push(value);
      i = skipSpace(text, next);
      if (text[i] === ',') {
        i = skipSpace(text, i + 1);
      } else if (text[i] === ')') {
        i = skipSpace(text, i + 1);
        break;
      } else {
        throw new Error(`Expected , or ) near: ${text.slice(i, i + 40)}`);
      }
    }
    rows.push(row);
    if (text[i] === ',') i = skipSpace(text, i + 1);
    else break;
  }
  return rows;
}

function parseColumns(body) {
  const columns = [];
  for (const raw of body.split('\n')) {
    const match = /^\s*`([^`]+)`\s+([a-zA-Z]+)(\([^)]*\))?(\s+unsigned)?/i.exec(raw);
    if (match) columns.push({ name: match[1], type: match[2].toLowerCase(), size: match[3]?.slice(1, -1) ?? null, autoIncrement: /auto_increment/i.test(raw) });
  }
  return columns;
}

const nextAutoIncrement = (text) => {
  const match = /\bAUTO_INCREMENT\s*=\s*(\d+)/i.exec(text);
  return match ? Number(match[1]) : null;
};

/**
 * Returns { tables: Map<name, { columns, rows, autoIncrement }>, database, timeZone, generatedAt, format }.
 * `rows` are objects keyed by column name. timeZone is the offset TIMESTAMP columns were written
 * in, or null when the dump does not say (then they are in the server's own local time).
 */
export function parseDump(sqlText) {
  const sql = sqlText.replace(/^﻿/, '');
  const tables = new Map();
  const databases = new Set();
  let timeZone = null;
  let sawData = false;

  const describe = (name) => {
    if (!tables.has(name)) throw new Error(`Rows for \`${name}\` appear before its CREATE TABLE.`);
    return tables.get(name);
  };

  for (const statement of splitStatements(sql)) {
    const head = statement.slice(0, 200);
    let match;
    if ((match = /^(?:\/\*!\d+\s+)?CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`\s*\(/i.exec(head))) {
      if (tables.has(match[1])) {
        throw new Error(`\`${match[1]}\` is defined more than once. Export only the one Franchise Titan database, not several.`);
      }
      const closing = statement.lastIndexOf(')');
      tables.set(match[1], {
        columns: parseColumns(statement.slice(statement.indexOf('(') + 1, closing)),
        rows: [],
        autoIncrement: nextAutoIncrement(statement.slice(closing)),
      });
      sawData = true;
    } else if ((match = /^(?:INSERT(?:\s+IGNORE)?|REPLACE)\s+INTO\s+`([^`]+)`\s*(\(([^)]*)\))?\s*VALUES\s*/i.exec(statement))) {
      const table = describe(match[1]);
      const names = match[3] ? match[3].split(',').map((c) => c.trim().replace(/^`|`$/g, '')) : table.columns.map((c) => c.name);
      for (const values of parseRows(statement, match[0].length)) {
        if (values.length !== names.length) throw new Error(`\`${match[1]}\`: a row has ${values.length} values for ${names.length} columns.`);
        table.rows.push(Object.fromEntries(names.map((name, i) => [name, values[i]])));
      }
      sawData = true;
    } else if ((match = /^ALTER\s+TABLE\s+`([^`]+)`/i.exec(head))) {
      const counter = nextAutoIncrement(statement);
      if (counter !== null && tables.has(match[1])) tables.get(match[1]).autoIncrement = counter;
    } else if ((match = /^USE\s+`?([^`\s;]+)`?/i.exec(head))) {
      databases.add(match[1]);
    } else if (!sawData && (match = /SET\s+time_zone\s*=\s*['"]([^'"]+)['"]/i.exec(head))) {
      timeZone = match[1];
    } else if (!sawData && /SET\s+(?:SESSION\s+)?SQL_MODE\s*=.*NO_BACKSLASH_ESCAPES/i.test(head)) {
      throw new Error('This dump was written with NO_BACKSLASH_ESCAPES, which this importer does not read. Export it again without that mode.');
    }
  }

  if (databases.size > 1) throw new Error(`The dump holds ${databases.size} databases (${[...databases].join(', ')}). Export only the Franchise Titan one.`);
  if (!tables.size) throw new Error('No CREATE TABLE statements found. Is this a MySQL dump?');

  const header = sql.slice(0, 1000);
  const database = /Database:\s+`?([^`\s]+)`?/.exec(header)?.[1] ?? [...databases][0] ?? null;
  const generatedAt = /Generation Time:\s*(.+)/.exec(header)?.[1]?.trim() ?? /Dump completed on\s*(.+)/.exec(sql.slice(-300))?.[1]?.trim() ?? null;
  return { tables, database, timeZone, generatedAt, format: header.includes('phpMyAdmin') ? 'phpMyAdmin' : 'mysqldump' };
}
