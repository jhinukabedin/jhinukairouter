// lib/errors.ts — typed API errors. The global error handler in app.ts
// turns these into { error: { code, message } } JSON responses.
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST'): AppError =>
  new AppError(400, code, message);
export const unauthorized = (message = 'Unauthorized', code = 'UNAUTHORIZED'): AppError =>
  new AppError(401, code, message);
export const forbidden = (message = 'Forbidden', code = 'FORBIDDEN'): AppError =>
  new AppError(403, code, message);
export const notFound = (message = 'Not found', code = 'NOT_FOUND'): AppError =>
  new AppError(404, code, message);
export const conflict = (message: string, code = 'CONFLICT'): AppError =>
  new AppError(409, code, message);
export const tooManyRequests = (message = 'Too many requests', code = 'RATE_LIMITED'): AppError =>
  new AppError(429, code, message);
