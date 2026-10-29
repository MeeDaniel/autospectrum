export type SafeError = { name: string; code?: string; frames: string[] };

export function safeError(error: unknown): SafeError {
  const candidate = error instanceof Error ? error : null;
  const constructorName = candidate?.constructor.name;
  const name = constructorName && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(constructorName) ? constructorName : 'UnknownError';
  const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code = typeof rawCode === 'string' && /^(?:[A-Z0-9]{5}|(?:FST|ERR)_[A-Z0-9_]{1,64})$/.test(rawCode) ? rawCode : undefined;
  const frames = (candidate?.stack ?? '').split('\n').slice(1).flatMap(line => {
    const frame = line.match(/(?:^|[\\/])(app|auth|data|request-logging|migrate|staff-cli)(?:\.[A-Za-z0-9-]+)?\.(ts|js):(\d+):(\d+)\)?$/);
    return frame ? [`${frame[1]}.${frame[2]}:${frame[3]}:${frame[4]}`] : [];
  }).slice(0, 5);
  return { name, ...(code ? { code } : {}), frames };
}
