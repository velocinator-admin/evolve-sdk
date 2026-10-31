import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./index";

describe("protocol", () => {
  it("defines pv 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
