export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message?: string,
  ) {
    super(message ?? httpStatusMessage(statusCode));
    this.name = "HttpError";
  }
}

function httpStatusMessage(code: number): string {
  const messages: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    422: "Unprocessable Entity",
    500: "Internal Server Error",
  };
  return messages[code] ?? `HTTP Error ${code}`;
}
