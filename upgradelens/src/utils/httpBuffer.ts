import * as https from "https";
import { NetworkUnavailableError } from "./httpJson";

/**
 * Downloads a URL into memory, enforcing a hard size cap so a single
 * misbehaving or unexpectedly large tarball can't balloon memory usage
 * during a background analysis pass.
 */
export function getBuffer(url: string, options: { timeoutMs?: number; maxBytes?: number } = {}): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024; // 25 MB

  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "upgradelens-vscode-extension" }, timeout: timeoutMs },
      (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          reject(new NetworkUnavailableError(`Request to ${url} failed with status ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) {
            req.destroy();
            reject(new NetworkUnavailableError(`Response from ${url} exceeded the ${maxBytes}-byte limit`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new NetworkUnavailableError(`Request to ${url} timed out after ${timeoutMs}ms`));
    });
    req.on("error", (err) => reject(new NetworkUnavailableError(`Request to ${url} failed: ${err.message}`, err)));
  });
}
