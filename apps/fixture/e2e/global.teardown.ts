import { execFileSync } from "node:child_process";
import { APP_HOST, DOCKER_CONTAINER } from "./env";

/** T23.1: remove the main app's container (E2E_APP_HOST=docker); a no-op otherwise. */
export default function teardown() {
  if (APP_HOST !== "docker") return;
  try {
    execFileSync("docker", ["rm", "-f", DOCKER_CONTAINER], { stdio: "ignore" });
  } catch {}
}
