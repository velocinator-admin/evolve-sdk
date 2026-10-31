#!/usr/bin/env node
import { startFakeCloud } from "./index";

const port = Number(process.env.FAKE_CLOUD_PORT ?? 4010);
const cloud = await startFakeCloud(port);
console.warn(`[fake-cloud] listening on ${cloud.url}`);
