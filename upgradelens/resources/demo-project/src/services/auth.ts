import { legacyClient } from "demo-package";

export async function login(username: string, password: string) {
  return legacyClient.post("/login", { username, password });
}
