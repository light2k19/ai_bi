export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, d);
export const unauthorized = (m = "Sign in required") => new HttpError(401, m);
export const forbidden = (m = "You do not have access to this") => new HttpError(403, m);
export const notFound = (m = "Not found") => new HttpError(404, m);
export const conflict = (m: string, d?: unknown) => new HttpError(409, m, d);
export const tooMany = (m = "Too many requests, slow down") => new HttpError(429, m);
