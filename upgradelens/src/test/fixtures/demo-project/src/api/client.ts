import { oldApi } from "demo-package";

export function getUsers() {
  return oldApi("/users");
}
