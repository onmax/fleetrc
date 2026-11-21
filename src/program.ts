/** `fallback`, or the program `variable` names (a .js/.mjs file runs with node). */
export function program(variable: string, fallback: string): { command: string; prefix: string[] } {
  const custom = process.env[variable];
  if (!custom) return { command: fallback, prefix: [] };
  if (/\.(m?js)$/.test(custom)) return { command: process.execPath, prefix: [custom] };
  return { command: custom, prefix: [] };
}

export function notInstalled(command: string, fallback: string, variable: string): string {
  return command === fallback
    ? `${fallback} is not installed, or not on PATH`
    : `${command}, which ${variable} names, is not installed or not on PATH`;
}
