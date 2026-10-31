import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeCloud, startFakeCloud } from "./index";

let cloud: FakeCloud;
beforeAll(async () => {
  cloud = await startFakeCloud();
});
afterAll(() => cloud.close());

describe("fake cloud", () => {
  it("answers /health", async () => {
    const res = await fetch(`${cloud.url}/health`);
    expect(res.status).toBe(200);
  });
});
