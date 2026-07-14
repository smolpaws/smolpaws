export class AgentServerHttpClient {
  constructor(
    readonly host: string,
    private readonly sessionApiKey: string,
  ) {}

  getJson<T>(pathname: string, expectedStatus = 200): Promise<T> {
    return this.requestJson<T>('GET', pathname, undefined, expectedStatus);
  }

  postJson<T = Record<string, never>>(pathname: string, body: unknown, expectedStatus = 200): Promise<T> {
    return this.requestJson<T>('POST', pathname, body, expectedStatus);
  }

  patchJson<T = Record<string, never>>(pathname: string, body: unknown, expectedStatus = 200): Promise<T> {
    return this.requestJson<T>('PATCH', pathname, body, expectedStatus);
  }

  putJson<T = Record<string, never>>(pathname: string, body: unknown, expectedStatus = 200): Promise<T> {
    return this.requestJson<T>('PUT', pathname, body, expectedStatus);
  }

  deleteJson<T = Record<string, never>>(pathname: string, expectedStatus = 200): Promise<T> {
    return this.requestJson<T>('DELETE', pathname, undefined, expectedStatus);
  }

  getText(pathname: string, expectedStatus = 200): Promise<string> {
    return this.requestText('GET', pathname, expectedStatus);
  }

  raw(pathname: string, authenticated = true): Promise<Response> {
    return fetch(`${this.host}${pathname}`, {
      headers: authenticated ? { 'x-session-api-key': this.sessionApiKey } : {},
    });
  }

  private async requestJson<T>(method: string, pathname: string, body: unknown, expectedStatus: number): Promise<T> {
    const response = await fetch(`${this.host}${pathname}`, {
      method,
      headers: {
        'x-session-api-key': this.sessionApiKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assertEqual(response.status, expectedStatus, `${method} ${pathname} status: ${text}`);
    return (text.length === 0 ? {} : JSON.parse(text)) as T;
  }

  private async requestText(method: string, pathname: string, expectedStatus: number): Promise<string> {
    const response = await fetch(`${this.host}${pathname}`, {
      method,
      headers: { 'x-session-api-key': this.sessionApiKey },
    });
    const text = await response.text();
    assertEqual(response.status, expectedStatus, `${method} ${pathname} status: ${text}`);
    return text;
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

export async function waitFor(assertion: () => Promise<void> | void, timeoutMs: number, intervalMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
