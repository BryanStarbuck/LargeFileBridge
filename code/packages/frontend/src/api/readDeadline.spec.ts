// The read/command split in api/axios.ts, asserted through the interceptor itself.
//
// WHY IT MATTERS BOTH WAYS. A read with no deadline is the hang this fix exists to close. A COMMAND with a
// deadline is the opposite mistake and just as bad: `/ipfs/rescan` walks the whole pinset and `/ipfs/daemon`
// starts Kubo, so cutting one off at 45s would abandon work that is still running server-side and leave the
// UI reporting a failure for something that actually succeeded.
import { describe, expect, it } from "vitest";
import { http } from "./axios.js";
import { READ_DEADLINE_MS } from "../lib/deadline.js";

type Handler = { fulfilled?: (c: Record<string, unknown>) => Record<string, unknown> };

/** The deadline interceptor is the FIRST request handler registered on the instance (axios.ts). */
function applyDeadlineInterceptor(config: Record<string, unknown>): Record<string, unknown> {
  const handlers = (http.interceptors.request as unknown as { handlers: Handler[] }).handlers;
  const first = handlers[0]?.fulfilled;
  expect(first, "axios.ts must register the deadline interceptor first").toBeTypeOf("function");
  return first!(config);
}

describe("the axios read deadline", () => {
  it("bounds a GET", () => {
    expect(applyDeadlineInterceptor({ method: "get" }).timeout).toBe(READ_DEADLINE_MS);
  });

  it("bounds a request with no method named (axios defaults to GET)", () => {
    expect(applyDeadlineInterceptor({}).timeout).toBe(READ_DEADLINE_MS);
  });

  it("is case-insensitive about the method", () => {
    expect(applyDeadlineInterceptor({ method: "GET" }).timeout).toBe(READ_DEADLINE_MS);
  });

  it("leaves a POST unbounded — commands may legitimately run for minutes", () => {
    expect(applyDeadlineInterceptor({ method: "post" }).timeout).toBeUndefined();
  });

  it("leaves PUT and DELETE unbounded too", () => {
    expect(applyDeadlineInterceptor({ method: "put" }).timeout).toBeUndefined();
    expect(applyDeadlineInterceptor({ method: "delete" }).timeout).toBeUndefined();
  });

  it("never overrides a deadline the caller set for itself", () => {
    expect(applyDeadlineInterceptor({ method: "get", timeout: 1_234 }).timeout).toBe(1_234);
  });
});
