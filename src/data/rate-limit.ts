export class RateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Слишком много заявок. Попробуйте позже.');
    this.name = 'RateLimitError';
  }
}
