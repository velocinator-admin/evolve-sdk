#!/usr/bin/env node
import { startFakeCloud, TEST_PUBLIC_KEY_ENV, TEST_SECRET_KEY, TEST_WEBHOOK_SECRET } from "./index";

const port = Number(process.env.FAKE_CLOUD_PORT ?? 4010);
const downSites = (process.env.FAKE_CLOUD_DOWN_SITES ?? "").split(",").filter(Boolean);
const cloud = await startFakeCloud({ port, downSites });
console.warn(`[fake-cloud] listening on ${cloud.url}
  EVOLVE_CLOUD_URL=${cloud.url}
  EVOLVE_SECRET_KEY=${TEST_SECRET_KEY}
  EVOLVE_WEBHOOK_SECRET=${TEST_WEBHOOK_SECRET}
  EVOLVE_UNSAFE_TEST_PUBLIC_KEY=${TEST_PUBLIC_KEY_ENV}`);
