export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : method,
    credentials: "same-origin",
    headers:
      body === undefined
        ? {}
        : body instanceof FormData
          ? { "X-Tab-Request": "1" }
          : { "Content-Type": "application/json", "X-Tab-Request": "1" },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const json = (await response.json()) as {
    data?: T;
    error?: { message: string };
  };
  if (!response.ok)
    throw new ApiError(
      json.error?.message || "Request failed.",
      response.status,
    );
  return json.data as T;
}
export const money = (n: number) =>
  `${n < 0 ? "−" : ""}$${Math.floor(Math.abs(n) / 100).toLocaleString()}.${String(Math.abs(n) % 100).padStart(2, "0")}`;
export const key = () => crypto.randomUUID();
