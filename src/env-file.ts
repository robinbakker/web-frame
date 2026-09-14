import dotenv from 'dotenv';

// Read normal dotenv assignments, including multiline quoted values. Double-quoted
// JSON strings additionally allow UI passwords to contain every quote/backslash combination.
const assignment = /^[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*=[ \t]*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|(?!['"`])[^\n]*)[ \t]*(?:#[^\n]*)?$/gm;

function records(text: string) {
  const normalized = text.replace(/\r\n?/g, '\n');
  const matches = [...normalized.matchAll(assignment)];
  const remainder = normalized.replace(assignment, '');
  if (remainder.split('\n').some((line) => line.trim() && !line.trim().startsWith('#'))) {
    throw new Error('Invalid .env syntax; check assignments and closing quotes');
  }
  return { normalized, matches };
}

export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const match of records(text).matches) {
    const key = match[1];
    const raw = match[2].trim();
    let value = dotenv.parse(match[0])[key] ?? '';
    if (raw.startsWith('"')) {
      try {
        value = JSON.parse(raw);
      } catch {
        // Existing dotenv double-quoted values need not use JSON escape sequences.
      }
    }
    values[key] = value;
  }
  return values;
}

export function updateEnv(text: string, updates: Record<string, string>): string {
  const { normalized } = records(text);
  const remaining = new Set(Object.keys(updates));
  let result = normalized.replace(assignment, (line, key: string) => {
    if (!Object.hasOwn(updates, key)) return line;
    remaining.delete(key);
    return `${key}=${JSON.stringify(updates[key])}`;
  });
  if (result && !result.endsWith('\n')) result += '\n';
  for (const key of remaining) result += `${key}=${JSON.stringify(updates[key])}\n`;
  const expected = { ...parseEnv(text), ...updates };
  const actual = parseEnv(result);
  if (Object.keys(actual).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
    throw new Error('Could not safely serialize .env settings');
  }
  return result;
}
