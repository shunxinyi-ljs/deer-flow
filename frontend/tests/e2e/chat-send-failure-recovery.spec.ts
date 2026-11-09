import { expect, test } from "@playwright/test";

import { enUS } from "../../src/core/i18n/locales/en-US";

import { mockLangGraphAPI } from "./utils/mock-api";

// Regression: a first send that the gateway rejects with a 5xx must not take
// the user's text, the welcome layout, or leave an empty "Untitled" thread
// behind. The SDK creates the thread before it opens the run stream, so the
// failed request has to roll that thread back.

test.describe("Chat: failed first send recovery", () => {
  test("keeps the composer text, restores the welcome layout, and deletes the empty thread", async ({
    page,
  }) => {
    const createdThreadIds: string[] = [];
    const deletes: string[] = [];

    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/api/langgraph/threads")
      ) {
        const body = request.postDataJSON() as { thread_id?: string } | null;
        if (body?.thread_id) {
          createdThreadIds.push(body.thread_id);
        }
      }
      if (request.method() === "DELETE") {
        deletes.push(request.url());
      }
    });

    mockLangGraphAPI(page, { honorRequestedThreadId: true });
    // A thread whose run never started has no checkpoint, and the gateway
    // answers its state request with 404. The shared mock invents a
    // two-message conversation for every known thread, which would hide the
    // rollback, so mirror the real contract here.
    await page.route("**/api/langgraph/threads/*/state", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Thread not found" }),
      }),
    );
    for (const streamUrl of [
      "**/api/langgraph/threads/*/runs/stream",
      "**/api/langgraph/runs/stream",
    ]) {
      await page.route(streamUrl, (route) =>
        route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ detail: "upstream failed" }),
        }),
      );
    }

    await page.goto("/workspace/chats/new");

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(enUS.welcome.greeting).first()).toBeVisible();

    await textarea.fill("Summarize the attached notes");
    await textarea.press("Enter");

    // Failure keeps the draft and brings the welcome layout back.
    await expect(textarea).toHaveValue("Summarize the attached notes", {
      timeout: 15_000,
    });
    await expect(page.getByText(enUS.welcome.greeting).first()).toBeVisible();

    // The thread created before the rejected run is rolled back.
    expect(createdThreadIds.length).toBeGreaterThan(0);
    const createdThreadId = createdThreadIds[0] ?? "";
    await expect
      .poll(
        () => deletes.some((url) => url.includes(createdThreadId)),
        { timeout: 15_000 },
      )
      .toBe(true);

    // Two independent proofs of removal: the delete was requested above, and
    // the thread is gone from the server-side list after a reload. The shared
    // mock removes a thread when its DELETE arrives, so the list response (not
    // the DOM) is what shows the removal actually happened.
    const searchResponse = page.waitForResponse(
      (response) => response.url().endsWith("/threads/search") && response.ok(),
    );
    await page.reload();
    const listed = (await (await searchResponse).json()) as Array<{
      thread_id?: string;
    }>;
    expect(listed.some((thread) => thread.thread_id === createdThreadId)).toBe(
      false,
    );
    await expect(page.getByText(enUS.welcome.greeting).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator(`a[href*="/workspace/chats/${createdThreadId}"]`),
    ).toHaveCount(0);
  });
});
