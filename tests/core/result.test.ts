import { describe, expect, it } from "vitest";
import { err, ok, type Result } from "../../src/core/result";

describe("Result", () => {
  it("wraps a success value", () => {
    const result: Result<number, string> = ok(42);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it("wraps an expected failure", () => {
    const result: Result<number, string> = err("invalid");
    expect(result).toEqual({ ok: false, error: "invalid" });
  });

  it("narrows on the ok flag", () => {
    const results: Result<number, string>[] = [ok(1), err("no")];
    const values = results.map((r) => (r.ok ? r.value : r.error));
    expect(values).toEqual([1, "no"]);
  });
});
