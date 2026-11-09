import { afterEach, beforeEach, expect, rs, test } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { I18nContext } from "@/core/i18n/context";
import { enUS } from "@/core/i18n/locales/en-US";
import { DEFAULT_LOCAL_SETTINGS } from "@/core/settings/local";
import type { UploadResponse } from "@/core/uploads/api";

// The first send of a new conversation goes through two different failure
// shapes, and only one of them rejects:
//
//   1. a rejected run (`/runs/stream` 5xx) is swallowed by the SDK's stream
//      manager, which reports it through `onError` while `thread.submit`
//      resolves — the thread the SDK created for the send stays behind empty;
//   2. a rejected submit (`POST /threads` failing) rejects for real.
//
// Both must roll the empty thread back and hand the text back to the composer.
// These tests drive the real failure shapes: `submit` resolves and `onError`
// fires, instead of making the mocked submit reject.

const mocks = rs.hoisted(() => ({
  submit: rs.fn(async () => undefined),
  streamOptions: undefined as
    | undefined
    | {
        onCreated?: (meta: { thread_id: string; run_id: string }) => void;
        onError?: (error: unknown, run?: unknown) => void;
      },
}));

rs.mock("@langchain/langgraph-sdk/react", () => ({
  useStream: (options: {
    onCreated?: (meta: { thread_id: string; run_id: string }) => void;
    onError?: (error: unknown, run?: unknown) => void;
  }) => {
    mocks.streamOptions = options;
    return {
      isLoading: false,
      messages: [],
      stop: rs.fn(async () => undefined),
      submit: mocks.submit,
      values: { artifacts: [], messages: [], title: "", todos: [] },
    };
  },
}));

const UPLOAD_RESPONSE: UploadResponse = {
  success: true,
  files: [
    {
      filename: "notes.txt",
      size: 12,
      path: "/data/uploads/notes.txt",
      virtual_path: "/mnt/user-data/uploads/notes.txt",
      artifact_url: "/api/threads/thread-1/artifacts/notes.txt",
    },
  ],
  message: "ok",
  skipped_files: [],
};

const MESSAGE_WITH_FILE: PromptInputMessage = {
  text: "Read this",
  files: [
    {
      type: "file",
      url: "blob:notes",
      mediaType: "text/plain",
      filename: "notes.txt",
      file: new File(["hello"], "notes.txt", { type: "text/plain" }),
    },
  ],
};

const REJECTED_RUN = Object.assign(
  new Error('HTTP 502: {"detail":"upstream failed"}'),
  { status: 502 },
);

type RequestLog = { method: string; url: string };

const requests: RequestLog[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubbedDeletes() {
  return requests
    .filter((entry) => entry.method === "DELETE")
    .map((entry) => entry.url);
}

function stubbedStateReads() {
  return requests.filter(
    (entry) => entry.url.includes("/state"),
  );
}

function stubFetch({
  uploadStatus = 200,
  stateResponses = [],
}: {
  uploadStatus?: number;
  /** Responses for successive GET .../state calls (the last one repeats). */
  stateResponses?: Array<{ status: number; body?: unknown }>;
} = {}) {
  let stateCall = 0;
  rs.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ method, url });
    if (method === "DELETE") {
      return json({ ok: true });
    }
    if (url.includes("/state")) {
      const response = stateResponses[Math.min(stateCall, stateResponses.length - 1)];
      stateCall += 1;
      return json(response?.body ?? { detail: "Thread not found" }, response?.status ?? 404);
    }
    if (url.includes("/messages/page")) {
      return json({ data: [], has_more: false, next_before_seq: null });
    }
    if (url.endsWith("/uploads")) {
      return json(
        uploadStatus === 200 ? UPLOAD_RESPONSE : { detail: "disk full" },
        uploadStatus,
      );
    }
    if (url.includes("/runs?") || url.endsWith("/runs")) {
      return json([]);
    }
    return json({});
  });
}

function createWrapper(queryClient: QueryClient) {
  return function SendFailureTestWrapper({
    children,
  }: {
    children: ReactNode;
  }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        I18nContext.Provider,
        {
          value: { locale: "en-US", setLocale: () => undefined, t: enUS },
        },
        children,
      ),
    );
  };
}

async function flushFrames() {
  for (let index = 0; index < 10; index += 1) {
    await act(async () => undefined);
  }
}

async function renderThreadStream(
  options: {
    threadId?: string;
    onSendFailed?: (info: { threadId: string; text: string }) => void;
  } = {},
) {
  const { useThreadStream } = await import("@/core/threads/hooks");
  const rendered = renderHook(
    () =>
      useThreadStream({
        context: DEFAULT_LOCAL_SETTINGS.context,
        isMock: false,
        threadId: options.threadId,
        onSendFailed: options.onSendFailed,
      }),
    {
      wrapper: createWrapper(
        new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      ),
    },
  );
  await flushFrames();
  return rendered;
}

async function failRun(error: unknown = REJECTED_RUN) {
  await act(async () => {
    mocks.streamOptions?.onError?.(error, undefined);
  });
  await flushFrames();
}

beforeEach(() => {
  requests.length = 0;
  mocks.submit.mockReset();
  mocks.streamOptions = undefined;
});

afterEach(() => {
  rs.unstubAllGlobals();
});

test("a first send whose run is rejected rolls back the empty thread and returns the text", async () => {
  // The thread exists but has no checkpoint yet: the gateway answers 404.
  stubFetch({ stateResponses: [{ status: 404 }] });
  const onSendFailed = rs.fn();
  const { result } = await renderThreadStream({ onSendFailed });

  // The SDK resolves the submit; the failure arrives later on the stream.
  await act(async () => {
    await result.current.sendMessage("new-thread-id", {
      text: "Hello",
      files: [],
    });
  });
  expect(onSendFailed).not.toHaveBeenCalled();

  await failRun();

  expect(onSendFailed).toHaveBeenCalledTimes(1);
  expect(onSendFailed).toHaveBeenCalledWith({
    threadId: "new-thread-id",
    text: "Hello",
  });
  // The empty thread is inspected before it is deleted.
  expect(stubbedStateReads()).toHaveLength(1);
  expect(
    stubbedDeletes().some((url) =>
      url.includes("/api/langgraph/threads/new-thread-id"),
    ),
  ).toBe(true);
  expect(
    stubbedDeletes().some((url) => url.includes("/api/threads/new-thread-id")),
  ).toBe(true);
});

test("a run that started before failing keeps its thread", async () => {
  stubFetch({ stateResponses: [{ status: 404 }] });
  const onSendFailed = rs.fn();
  const { result } = await renderThreadStream({ onSendFailed });

  await act(async () => {
    await result.current.sendMessage("new-thread-id", {
      text: "Hello",
      files: [],
    });
  });
  // The stream announced the run before it failed: the thread is real now.
  await act(async () => {
    mocks.streamOptions?.onCreated?.({
      thread_id: "new-thread-id",
      run_id: "run-1",
    });
  });
  await failRun();

  expect(onSendFailed).not.toHaveBeenCalled();
  expect(stubbedStateReads()).toHaveLength(0);
  expect(stubbedDeletes()).toEqual([]);
});

test("a thread that already holds messages is never deleted", async () => {
  // The run never reported creation, but the turn did land: keep the thread
  // and still recover the composer text.
  stubFetch({
    stateResponses: [
      {
        status: 200,
        body: {
          values: { messages: [{ type: "human", id: "m1" }] },
          checkpoint: { id: "c1" },
        },
      },
    ],
  });
  const onSendFailed = rs.fn();
  const { result } = await renderThreadStream({ onSendFailed });

  await act(async () => {
    await result.current.sendMessage("new-thread-id", {
      text: "Hello",
      files: [],
    });
  });
  await failRun();

  expect(onSendFailed).toHaveBeenCalledWith({
    threadId: "new-thread-id",
    text: "Hello",
  });
  expect(stubbedStateReads()).toHaveLength(1);
  expect(stubbedDeletes()).toEqual([]);
});

test("a rejected submit (thread creation failed) also returns the text", async () => {
  stubFetch({ stateResponses: [{ status: 404 }] });
  mocks.submit.mockImplementationOnce(async () => {
    throw REJECTED_RUN;
  });
  const onSendFailed = rs.fn();
  const { result } = await renderThreadStream({ onSendFailed });

  await act(async () => {
    await result.current
      .sendMessage("new-thread-id", { text: "Hello", files: [] })
      .catch(() => undefined);
  });
  await flushFrames();

  expect(onSendFailed).toHaveBeenCalledTimes(1);
  expect(onSendFailed).toHaveBeenCalledWith({
    threadId: "new-thread-id",
    text: "Hello",
  });
  expect(
    stubbedDeletes().some((url) =>
      url.includes("/api/langgraph/threads/new-thread-id"),
    ),
  ).toBe(true);
});

test("a state read that fails for another reason never deletes the thread", async () => {
  // A 500 does not prove the thread is empty, so it must be left alone.
  stubFetch({ stateResponses: [{ status: 500, body: { detail: "boom" } }] });
  const onSendFailed = rs.fn();
  const { result } = await renderThreadStream({ onSendFailed });

  await act(async () => {
    await result.current.sendMessage("new-thread-id", {
      text: "Hello",
      files: [],
    });
  });
  await failRun();

  expect(onSendFailed).toHaveBeenCalledTimes(1);
  expect(stubbedStateReads()).toHaveLength(1);
  expect(stubbedDeletes()).toEqual([]);
});

test("an upload failure never inspects or deletes the thread", async () => {
  stubFetch({ uploadStatus: 500 });
  const onSendFailed = rs.fn();
  const { result } = await renderThreadStream({ onSendFailed });

  await act(async () => {
    await result.current
      .sendMessage("new-thread-id", MESSAGE_WITH_FILE)
      .catch(() => undefined);
  });
  await flushFrames();

  expect(onSendFailed).not.toHaveBeenCalled();
  expect(stubbedStateReads()).toHaveLength(0);
  expect(stubbedDeletes()).toEqual([]);
});
