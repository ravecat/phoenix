import { Socket } from "phoenix"
import { describe, expect, it, vi } from "vitest"
import { session as createSession } from "../src"
import type { MockPush, MockSocket } from "./support/phoenix"

vi.mock("phoenix", () => import("./support/phoenix"))

type StoreStateOf<TStore> = TStore extends {
  subscribe(listener: (value: infer TValue) => void): () => void
}
  ? TValue
  : never

type TestValue = {
  count: number
}

type TestSpec = {
  value: TestValue
  connect: {
    ok: TestValue
    error: { reason?: string }
  }
  events: {
    increment: { by: number }
  }
  actions: {
    start: {
      error: { reason?: string }
    }
    save: {
      payload: { id: string }
      error: { code: string }
    }
  }
}

const testSession = (
  config: Parameters<typeof createSession<TestSpec>>[1] = {
    topic: "counter:lobby",
  },
) => {
  const socket = new Socket("/socket") as MockSocket
  const store = createSession<TestSpec>(socket, config).extend(({ push }) => ({
    label: "Actions",
    start() {
      return push("server_start", {})
    },
    save(payload) {
      return push("server_save", payload)
    },
  }))
  let state: StoreStateOf<typeof store> | undefined
  const unsubscribe = store.subscribe((nextState) => {
    state = nextState
  })
  const channel = socket.channels[0]

  return {
    channel,
    store,
    get state() {
      if (state === undefined) {
        throw new Error("Expected test session to be subscribed")
      }

      return state
    },
    unsubscribe,
  }
}

describe("session lifecycle", () => {
  it("should start loading without an initial value", () => {
    const subject = testSession()

    expect(subject.state).toEqual({
      value: null,
      status: "loading",
      error: null,
      processing: {
        start: false,
        save: false,
      },
      errors: {
        start: {},
        save: {},
      },
      timeouts: {
        start: false,
        save: false,
      },
    })
  })

  it("should start loading with an initial value", () => {
    const subject = testSession({
      topic: "counter:lobby",
      value: { count: 1 },
    })

    expect(subject.state).toMatchObject({
      value: { count: 1 },
      status: "loading",
      error: null,
    })
  })

  it("should join the configured topic on mount", () => {
    const subject = testSession({
      topic: "counter:lobby",
    })

    expect(subject.channel.topic).toBe("counter:lobby")
    expect(subject.channel.params).toEqual({})
  })

  it("should use join ok response as value by default", () => {
    const subject = testSession()

    subject.channel.joinPush.reply("ok", { count: 2 })

    expect(subject.state).toMatchObject({
      value: { count: 2 },
      status: "ready",
      error: null,
    })
  })

  it("should normalize join ok response through connect.ok", () => {
    const subject = testSession({
      topic: "counter:lobby",
      value: { count: 1 },
      connect: {
        ok: (value, reply) => ({ count: (value?.count ?? 0) + reply.count }),
      },
    })

    subject.channel.joinPush.reply("ok", { count: 2 })

    expect(subject.state).toMatchObject({
      value: { count: 3 },
      status: "ready",
      error: null,
    })
  })

  it("should map join errors through connect.error", () => {
    const subject = testSession({
      topic: "counter:lobby",
      connect: {
        error: (reply) => reply.reason ?? "join_failed",
      },
    })

    subject.channel.joinPush.reply("error", { reason: "unauthorized" })

    expect(subject.state).toMatchObject({
      status: "failed",
      error: { kind: "connect_error", cause: "unauthorized" },
    })
  })

  it("should map join timeout through connect.timeout", () => {
    const subject = testSession({
      topic: "counter:lobby",
      connect: {
        timeout: () => "join_timeout",
      },
    })

    subject.channel.joinPush.reply("timeout")

    expect(subject.state).toMatchObject({
      status: "failed",
      error: { kind: "connect_timeout", cause: "join_timeout" },
    })
  })

  it("should mark empty sessions failed on transport error", () => {
    const subject = testSession()
    const cause = { reason: "transport_down" }

    subject.channel.error(cause)

    expect(subject.state).toMatchObject({
      value: null,
      status: "failed",
      error: { kind: "transport_error", cause },
    })
  })

  it("should mark valued sessions failed on transport error before join ok", () => {
    const subject = testSession({
      topic: "counter:lobby",
      value: { count: 1 },
    })
    const cause = { reason: "transport_down" }

    subject.channel.error(cause)

    expect(subject.state).toMatchObject({
      value: { count: 1 },
      status: "failed",
      error: { kind: "transport_error", cause },
    })
  })

  it("should mark connected sessions stale on transport error", () => {
    const subject = testSession()
    const cause = { reason: "transport_down" }

    subject.channel.joinPush.reply("ok", { count: 1 })
    subject.channel.error(cause)

    expect(subject.state).toMatchObject({
      value: { count: 1 },
      status: "stale",
      error: { kind: "transport_error", cause },
    })
  })

  it("should mark empty sessions failed on channel close", () => {
    const subject = testSession()

    subject.channel.close()

    expect(subject.state).toMatchObject({
      value: null,
      status: "failed",
      error: { kind: "transport_close" },
    })
  })

  it("should mark valued sessions failed on channel close before join ok", () => {
    const subject = testSession({
      topic: "counter:lobby",
      value: { count: 1 },
    })

    subject.channel.close()

    expect(subject.state).toMatchObject({
      value: { count: 1 },
      status: "failed",
      error: { kind: "transport_close" },
    })
  })

  it("should mark connected sessions stale on channel close", () => {
    const subject = testSession()

    subject.channel.joinPush.reply("ok", { count: 1 })
    subject.channel.close()

    expect(subject.state).toMatchObject({
      value: { count: 1 },
      status: "stale",
      error: { kind: "transport_close" },
    })
  })

  it("should run configured event reducers with current value and payload", () => {
    const subject = testSession({
      topic: "counter:lobby",
      value: { count: 1 },
      events: {
        increment: (value, payload) => ({ count: (value?.count ?? 0) + payload.by }),
      },
    })

    subject.channel.receive("increment", { by: 2 })
    subject.channel.receive("increment", { by: 3 })

    expect(subject.state).toMatchObject({
      value: { count: 6 },
      status: "ready",
      error: null,
    })
  })

  it("should clear session-level error after a configured event", () => {
    const subject = testSession({
      topic: "counter:lobby",
      events: {
        increment: (value, payload) => ({ count: (value?.count ?? 0) + payload.by }),
      },
    })

    subject.channel.error({ reason: "down" })
    subject.channel.receive("increment", { by: 1 })

    expect(subject.state).toMatchObject({
      value: { count: 1 },
      status: "ready",
      error: null,
    })
  })

  it("should remove handlers and leave channel on unsubscribe", () => {
    vi.useFakeTimers()
    const subject = testSession({
      topic: "counter:lobby",
      events: {
        increment: (value, payload) => ({ count: (value?.count ?? 0) + payload.by }),
      },
    })

    subject.unsubscribe()
    vi.advanceTimersByTime(1000)

    expect(subject.channel.off).toHaveBeenCalledWith("phx_error", expect.any(Number))
    expect(subject.channel.off).toHaveBeenCalledWith("phx_close", expect.any(Number))
    expect(subject.channel.off).toHaveBeenCalledWith("increment", expect.any(Number))
    expect(subject.channel.leave).toHaveBeenCalledTimes(1)
    expect(() => subject.store.start()).toThrow(
      'Cannot push "server_start" before joining "counter:lobby"',
    )

    vi.useRealTimers()
  })
})

describe("session actions", () => {
  it("should register buckets for extension function keys", () => {
    const subject = testSession()

    expect(subject.state.processing).toEqual({
      start: false,
      save: false,
    })
    expect(subject.state.errors).toEqual({
      start: {},
      save: {},
    })
    expect(subject.state.timeouts).toEqual({
      start: false,
      save: false,
    })
  })

  it("should not register buckets for non-function extension values", () => {
    const subject = testSession()

    expect(subject.store.label).toBe("Actions")
    expect("label" in subject.state.processing).toBe(false)
  })

  it("should track extension pushes by public method name", () => {
    const subject = testSession()

    const push = subject.store.start() as MockPush

    expect(push.event).toBe("server_start")
    expect(subject.state.processing.start).toBe(true)
    expect("server_start" in subject.state.processing).toBe(false)

    push.reply("ok")

    expect(subject.state.processing.start).toBe(false)
    expect(subject.state.errors.start).toEqual({})
    expect(subject.state.timeouts.start).toBe(false)
  })

  it("should use event name as fallback bucket for direct push calls", () => {
    const socket = new Socket("/socket") as MockSocket
    const store = createSession<TestSpec>(socket, {
      topic: "actions:lobby",
      value: { count: 0 },
    })
    let state: StoreStateOf<typeof store> | undefined
    store.subscribe((nextState) => {
      state = nextState
    })

    store.push("raw_event", {})

    expect((state?.processing as Record<string, unknown>).raw_event).toBe(true)
  })

  it("should throw when pushing before the channel is mounted", () => {
    const socket = new Socket("/socket")
    const store = createSession<TestSpec>(socket, {
      topic: "counter:lobby",
    })

    expect(() => store.push("increment", { by: 1 })).toThrow(
      'Cannot push "increment" before joining "counter:lobby"',
    )
  })

  it("should set processing true and clear previous errors/timeouts when a push starts", () => {
    const subject = testSession()

    const firstPush = subject.store.start() as MockPush
    firstPush.reply("error", { reason: "blocked" })
    subject.store.start()

    expect(subject.state.processing.start).toBe(true)
    expect(subject.state.errors.start).toEqual({})
    expect(subject.state.timeouts.start).toBe(false)
  })

  it("should store error replies on error", () => {
    const subject = testSession()

    const push = subject.store.start() as MockPush
    push.reply("error", { reason: "blocked" })

    expect(subject.state.processing.start).toBe(false)
    expect(subject.state.errors.start).toEqual({ reason: "blocked" })
    expect(subject.state.timeouts.start).toBe(false)
  })

  it("should store an empty object for nullish error replies", () => {
    const subject = testSession()

    const push = subject.store.start() as MockPush
    push.reply("error")

    expect(subject.state.errors.start).toEqual({})
  })

  it("should store timeout true on timeout", () => {
    const subject = testSession()

    const push = subject.store.start() as MockPush
    push.reply("timeout")

    expect(subject.state.processing.start).toBe(false)
    expect(subject.state.errors.start).toEqual({})
    expect(subject.state.timeouts.start).toBe(true)
  })

  it("should clear previous error and timeout on retry", () => {
    const subject = testSession()

    const firstPush = subject.store.start() as MockPush
    firstPush.reply("timeout")
    const secondPush = subject.store.start() as MockPush
    secondPush.reply("ok")

    expect(subject.state.processing.start).toBe(false)
    expect(subject.state.errors.start).toEqual({})
    expect(subject.state.timeouts.start).toBe(false)
  })
})

describe("session action races", () => {
  it("should ignore older error replies after a newer run starts", () => {
    const subject = testSession()

    const firstStart = subject.store.start() as MockPush
    const secondStart = subject.store.start() as MockPush

    firstStart.reply("error", { reason: "stale" })

    expect(subject.state.processing.start).toBe(true)
    expect(subject.state.errors.start).toEqual({})

    secondStart.reply("ok")

    expect(subject.state.processing.start).toBe(false)
    expect(subject.state.errors.start).toEqual({})
  })

  it("should keep newer completion when older reply arrives later", () => {
    const subject = testSession()

    const firstStart = subject.store.start() as MockPush
    const secondStart = subject.store.start() as MockPush

    secondStart.reply("error", { reason: "newer" })
    firstStart.reply("ok")

    expect(subject.state.processing.start).toBe(false)
    expect(subject.state.errors.start).toEqual({ reason: "newer" })
  })

  it("should track different actions independently", () => {
    const subject = testSession()

    const startPush = subject.store.start() as MockPush
    const savePush = subject.store.save({ id: "one" }) as MockPush

    expect(subject.state.processing.start).toBe(true)
    expect(subject.state.processing.save).toBe(true)

    startPush.reply("ok")

    expect(subject.state.processing.start).toBe(false)
    expect(subject.state.processing.save).toBe(true)

    savePush.reply("error", { code: "invalid" })

    expect(subject.state.errors.save).toEqual({ code: "invalid" })
  })
})
