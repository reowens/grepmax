import { describe, expect, it } from "vitest";
import { formatTimeAgo } from "../src/lib/utils/format-helpers";

describe("formatTimeAgo", () => {
  it("formats seconds", () => {
    expect(formatTimeAgo(5000)).toBe("5s ago");
    expect(formatTimeAgo(0)).toBe("0s ago");
    expect(formatTimeAgo(59_000)).toBe("59s ago");
  });

  it("formats minutes", () => {
    expect(formatTimeAgo(60_000)).toBe("1m ago");
    expect(formatTimeAgo(300_000)).toBe("5m ago");
    expect(formatTimeAgo(3_599_000)).toBe("59m ago");
  });

  it("formats hours", () => {
    expect(formatTimeAgo(3_600_000)).toBe("1h ago");
    expect(formatTimeAgo(7_200_000)).toBe("2h ago");
    expect(formatTimeAgo(86_399_000)).toBe("23h ago");
  });

  it("formats days", () => {
    expect(formatTimeAgo(86_400_000)).toBe("1d ago");
    expect(formatTimeAgo(172_800_000)).toBe("2d ago");
    expect(formatTimeAgo(604_800_000)).toBe("7d ago");
  });

  it("handles boundary transitions", () => {
    expect(formatTimeAgo(59_999)).toBe("59s ago");
    expect(formatTimeAgo(60_000)).toBe("1m ago");
    expect(formatTimeAgo(3_599_999)).toBe("59m ago");
    expect(formatTimeAgo(3_600_000)).toBe("1h ago");
  });
});
