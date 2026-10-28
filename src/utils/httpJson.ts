import * as https from "https";

export class NetworkUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "NetworkUnavailableError";
  }
}

/**
 * Fetches and parses a JSON document over HTTPS with a hard timeout.
 * Deliberately dependency-free (no axios/node-fetch) - this is the only
 * network call site in the extension, so a thin wrapper is enough and
 * keeps the dependency surface small.
 */
export function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "upgradelens-vscode-extension",
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          reject(new NetworkUnavailableError(`Request to ${url} failed with status ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
          } catch (err) {
            reject(new NetworkUnavailableError(`Malformed JSON response from ${url}`, err));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new NetworkUnavailableError(`Request to ${url} timed out after ${timeoutMs}ms`));
    });
    req.on("error", (err) => {
      reject(new NetworkUnavailableError(`Request to ${url} failed: ${err.message}`, err));
    });
  });
}


/** Fetches raw text over HTTPS with a hard timeout. */
export function getText(url: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Accept: "*/*",
          "User-Agent": "upgradelens-vscode-extension",
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          reject(new NetworkUnavailableError(`Request to ${url} failed with status ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new NetworkUnavailableError(`Request to ${url} timed out after ${timeoutMs}ms`));
    });
    req.on("error", (err) => {
      reject(new NetworkUnavailableError(`Request to ${url} failed: ${err.message}`, err));
    });
  });
}

/** HEAD-style existence check (GET with discard body). Returns true on 2xx. */
export function urlExists(url: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        headers: { "User-Agent": "upgradelens-vscode-extension" },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(!!res.statusCode && res.statusCode < 400);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}
