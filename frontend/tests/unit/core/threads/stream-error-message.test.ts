import { expect, test } from "@rstest/core";

import { getStreamErrorMessage } from "@/core/threads/hooks";

const friendly = (status: number) => `Service unavailable (HTTP ${status}).`;

test("5xx errors keep the status code but drop the raw response body", () => {
  const error = new Error('HTTP 502: {"detail":"upstream failed"}');
  Object.assign(error, { status: 502 });

  const message = getStreamErrorMessage(error, friendly);

  expect(message).toBe("Service unavailable (HTTP 502).");
  expect(message).not.toContain("upstream failed");
});

test("detects a 5xx status from the SDK message when status is absent", () => {
  expect(
    getStreamErrorMessage(
      new Error('HTTP 503: {"detail":"service unavailable"}'),
      friendly,
    ),
  ).toBe("Service unavailable (HTTP 503).");
});

test("4xx errors keep their original message", () => {
  expect(
    getStreamErrorMessage(new Error("HTTP 404: Thread not found"), friendly),
  ).toBe("HTTP 404: Thread not found");
});

test("non-HTTP errors keep their original message", () => {
  expect(getStreamErrorMessage(new Error("Network error"), friendly)).toBe(
    "Network error",
  );
});
