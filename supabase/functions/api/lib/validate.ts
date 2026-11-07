// Laravel's request validation, with the same rule strings and messages, so controllers
// port line by line and the frontend keeps showing the same errors.
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import type { Db, Row } from './db.ts';
import { manilaToday, ValidationError } from './http.ts';

// Laravel's global middleware: strings are trimmed and '' becomes null, except passwords.
const NOT_TRIMMED = new Set(['password', 'password_confirmation', 'current_password', 'confirm_password']);

function normalize(input: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && !NOT_TRIMMED.has(key)) {
      const trimmed = value.trim();
      out[key] = trimmed === '' ? null : trimmed;
    } else if (value === '') {
      out[key] = null;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Query string plus JSON or form body, as Laravel's $request->input() sees it. */
export async function readInput(c: Context<AppEnv>): Promise<Row> {
  const query = c.req.query();
  const type = c.req.header('content-type') ?? '';
  let body: Row = {};
  if (type.includes('application/json')) {
    const parsed = await c.req.json().catch(() => ({}));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
  } else if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
    body = await c.req.parseBody({ all: true });
  }
  return normalize({ ...query, ...body });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.?[^\s@]*$/;
type Rule = string | RegExp;

const label = (field: string) => field.replace(/_/g, ' ');
const isNumeric = (v: unknown) => v !== null && v !== '' && typeof v !== 'boolean' && !Number.isNaN(Number(v));
const isInt = (v: unknown) => isNumeric(v) && Number.isInteger(Number(v));
const size = (v: unknown) => (v instanceof File ? v.size / 1024 : typeof v === 'string' ? [...v].length : Array.isArray(v) ? v.length : Number(v));

/** Laravel's `field.*.x` rules: each row is validated, errors keep the full path. */
export async function validateEach(db: Db, rows: Row[], field: string, rules: Record<string, Rule[]>): Promise<Row[]> {
  const out: Row[] = [];
  const errors: Record<string, string[]> = {};
  for (const [index, row] of rows.entries()) {
    try {
      out.push(await validate(db, row, rules));
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      for (const [key, messages] of Object.entries(error.errors)) errors[`${field}.${index}.${key}`] = messages;
    }
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

/** Returns only the fields that have rules, like $request->validate(). */
export async function validate(db: Db, input: Row, rules: Record<string, Rule[]>): Promise<Row> {
  const errors: Record<string, string[]> = {};
  const out: Row = {};

  for (const [field, list] of Object.entries(rules)) {
    const names = list.filter((r): r is string => typeof r === 'string');
    const present = field in input;
    const value = input[field];
    const empty = value === null || value === undefined || (Array.isArray(value) && !value.length);
    const add = (message: string) => { (errors[field] ??= []).push(message); };

    if (names.includes('prohibited')) {
      if (present && !empty) add(`The ${label(field)} field is prohibited.`);
      continue;
    }
    if (names.includes('sometimes') && !present) continue;
    if (names.includes('present') && !present) { add(`The ${label(field)} field must be present.`); continue; }
    if (names.includes('required') && empty) { add(`The ${label(field)} field is required.`); continue; }
    const requiredIf = names.find((r) => r.startsWith('required_if:'));
    if (requiredIf && empty) {
      const [other, ...wanted] = requiredIf.slice('required_if:'.length).split(',');
      if (wanted.includes(String(input[other] ?? ''))) { add(`The ${label(field)} field is required when ${label(other)} is ${String(input[other])}.`); continue; }
    }
    if (names.includes('accepted') && ![true, 1, '1', 'yes', 'on', 'true'].includes(value)) { add(`The ${label(field)} field must be accepted.`); continue; }
    const requiredWith = names.find((r) => r.startsWith('required_with:'));
    if (requiredWith && empty && input[requiredWith.split(':')[1]]) { add(`The ${label(field)} field is required when ${label(requiredWith.split(':')[1])} is present.`); continue; }
    if (!present) continue;
    if (empty) {
      if (names.includes('nullable')) out[field] = null;
      continue;
    }

    let current = value;
    const numericRules = names.includes('integer') || names.includes('numeric');
    for (const rule of list) {
      if (rule instanceof RegExp) {
        if (!rule.test(String(current))) add(`The ${label(field)} field format is invalid.`);
        continue;
      }
      const [name, arg = ''] = rule.split(/:(.*)/s);
      if (name === 'string' && typeof current !== 'string') add(`The ${label(field)} field must be a string.`);
      else if (name === 'array' && !Array.isArray(current)) add(`The ${label(field)} field must be an array.`);
      else if (name === 'array_or_object' && (typeof current !== 'object' || current === null)) add(`The ${label(field)} field must be an array.`);
      else if (name === 'integer') { if (isInt(current)) current = Number(current); else add(`The ${label(field)} field must be an integer.`); }
      else if (name === 'numeric' && !isNumeric(current)) add(`The ${label(field)} field must be a number.`);
      else if (name === 'boolean') {
        if ([true, false, 1, 0, '1', '0'].includes(current)) current = current === true || current === 1 || current === '1';
        else add(`The ${label(field)} field must be true or false.`);
      } else if (name === 'email' && !EMAIL.test(String(current))) add(`The ${label(field)} field must be a valid email address.`);
      else if (name === 'date' && Number.isNaN(Date.parse(String(current)))) add(`The ${label(field)} field must be a valid date.`);
      else if (name === 'date_format' && arg === 'Y-m-d' && !(/^\d{4}-\d{2}-\d{2}$/.test(String(current)) && !Number.isNaN(Date.parse(String(current))))) add(`The ${label(field)} field must match the format Y-m-d.`);
      else if (name === 'after' && input[arg] && !(Date.parse(String(current)) > Date.parse(String(input[arg])))) add(`The ${label(field)} field must be a date after ${label(arg)}.`);
      else if (name === 'after_or_equal' && arg !== 'today' && input[arg] && !(Date.parse(String(current)) >= Date.parse(String(input[arg])))) add(`The ${label(field)} field must be a date after or equal to ${label(arg)}.`);
      else if (name === 'lte' && input[arg] !== undefined && Number(current) > Number(input[arg])) add(`The ${label(field)} field must be less than or equal to ${label(arg)}.`);
      else if (name === 'not_in' && arg.split(',').includes(String(current))) add(`The selected ${label(field)} is invalid.`);
      else if (name === 'gt' && !(Number(current) > Number(arg))) add(`The ${label(field)} field must be greater than ${arg}.`);
      else if (name === 'between' && (Number(current) < Number(arg.split(',')[0]) || Number(current) > Number(arg.split(',')[1]))) add(`The ${label(field)} field must be between ${arg.split(',')[0]} and ${arg.split(',')[1]}.`);
      else if (name === 'file' && !(current instanceof File)) add(`The ${label(field)} field must be a file.`);
      else if (name === 'mimes' && current instanceof File && !arg.split(',').includes((current.name.split('.').pop() ?? '').toLowerCase())) add(`The ${label(field)} field must be a file of type: ${arg.replace(/,/g, ', ')}.`);
      else if (name === 'before_or_equal' && arg === 'today' && String(current).slice(0, 10) > manilaToday()) add(`The ${label(field)} field must be a date before or equal to today.`);
      else if (name === 'after_or_equal' && arg === 'today' && String(current).slice(0, 10) < manilaToday()) add(`The ${label(field)} field must be a date after or equal to today.`);
      else if (name === 'alpha_dash' && !/^[\p{L}\p{N}_-]+$/u.test(String(current))) add(`The ${label(field)} field must only contain letters, numbers, dashes, and underscores.`);
      else if (name === 'in' && !arg.split(',').includes(String(current))) add(`The selected ${label(field)} is invalid.`);
      else if (name === 'min' && size(numericRules ? Number(current) : current) < Number(arg)) add(numericRules ? `The ${label(field)} field must be at least ${arg}.` : `The ${label(field)} field must be at least ${arg} characters.`);
      else if (name === 'max' && size(numericRules ? Number(current) : current) > Number(arg)) add(numericRules ? `The ${label(field)} field must not be greater than ${arg}.` : `The ${label(field)} field must not be greater than ${arg} characters.`);
      else if (name === 'confirmed' && input[`${field}_confirmation`] !== current) add(`The ${label(field)} field confirmation does not match.`);
      else if (name === 'same' && input[arg] !== current) add(`The ${label(field)} field must match ${label(arg)}.`);
      else if (name === 'exists') {
        const [table, col = 'id'] = arg.split(',');
        const found = await db.query(`select 1 from ${table} where ${col} = $1 limit 1`, [current]);
        if (!found.length) add(`The selected ${label(field)} is invalid.`);
      } else if (name === 'unique') {
        // Case-insensitive, because that is what MySQL's collation gave these checks.
        const [table, col, ignore] = arg.split(',');
        const found = await db.query(
          `select 1 from ${table} where lower(${col}::text) = lower($1)${ignore ? ' and id <> $2' : ''} limit 1`,
          ignore ? [String(current), Number(ignore)] : [String(current)],
        );
        if (found.length) add(`The ${label(field)} has already been taken.`);
      }
    }
    out[field] = current;
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}
