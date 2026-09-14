/** The final query term and the prefix which native datalist replacements must retain. */
export function completionTarget(input: string) {
  const tokens = [...input.matchAll(/(?:[^\s"]+|"(?:\\.|[^"\\])*"?)+/g)];
  const last = /\s$/.test(input) ? undefined : tokens.at(-1);
  const text = last?.[0] ?? '';
  const match = text.match(/^(-?)(@?([A-Za-z_][A-Za-z0-9_.]*):)?(.*)$/)!;
  let value = match[4];
  try { if (value.startsWith('"')) value = JSON.parse(value); }
  catch { value = value.slice(1); }
  return { prefix: input.slice(0, last?.index ?? input.length), negate: match[1], field: match[3], fieldText: match[2], value };
}

export function completeQuery(input: string, fields: string[], values: { value: string }[]): string[] {
  const target = completionTarget(input);
  const prefix = target.prefix + target.negate;
  const options = target.field
    ? values.map(({ value }) => prefix + target.fieldText + JSON.stringify(value))
    : fields.filter(field => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(field)).map(field => prefix + field + ':');
  return options.filter(value => value.length <= 256);
}
