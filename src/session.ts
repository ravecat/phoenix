import { atom, onMount } from "nanostores"
import type { Channel, Push, Socket } from "phoenix"

const CHANNEL_CLOSE_EVENT = "phx_close"
const CHANNEL_ERROR_EVENT = "phx_error"

type SessionStatus = "loading" | "ready" | "stale" | "failed"

type SessionError =
  | { kind: "connect_error"; cause: unknown }
  | { kind: "connect_timeout"; cause?: unknown }
  | { kind: "transport_error"; cause: unknown }
  | { kind: "transport_close" }

type SessionSpec = {
  value?: unknown
  connect?: { ok?: unknown; error?: unknown }
  events?: Record<string, unknown>
  actions?: Record<string, ActionSpec>
}

type ActionSpec = {
  [reply: string]: unknown
  payload?: object
  ok?: unknown
  error?: object
}

type ValueOf<TSpec extends SessionSpec> = TSpec extends {
  value: infer TValue
}
  ? TValue
  : unknown

type ConnectOkOf<TSpec extends SessionSpec> = TSpec extends {
  connect: { ok?: infer TOk }
}
  ? TOk
  : ValueOf<TSpec>

type ConnectErrorOf<TSpec extends SessionSpec> = TSpec extends {
  connect: { error?: infer TError }
}
  ? TError
  : unknown

type EventMapOf<TSpec extends SessionSpec> = TSpec extends {
  events: infer TEvents extends Record<string, unknown>
}
  ? TEvents
  : Record<never, never>

type ActionMapOf<TSpec extends SessionSpec> = TSpec extends {
  actions: infer TActions extends Record<string, ActionSpec>
}
  ? TActions
  : Record<never, never>

type ActionPayloadOf<
  TActions extends Record<string, ActionSpec>,
  TEvent extends string,
> = TEvent extends keyof TActions
  ? TActions[TEvent] extends { payload: infer TPayload extends object }
    ? TPayload
    : object
  : object

type ActionErrorOf<TAction extends ActionSpec> = TAction extends {
  error: infer TError extends object
}
  ? TError
  : object

type ActionProcessing<TActions extends Record<string, ActionSpec>> = {
  readonly [K in keyof TActions]: boolean
}

type ActionErrors<TActions extends Record<string, ActionSpec>> = {
  readonly [K in keyof TActions]: Partial<ActionErrorOf<TActions[K]>>
}

type ActionTimeouts<TActions extends Record<string, ActionSpec>> = {
  readonly [K in keyof TActions]: boolean
}

type ActionMethodOf<TAction extends ActionSpec> = TAction extends {
  payload: infer TPayload extends object
}
  ? (payload: TPayload, timeout?: number) => unknown
  : () => unknown

type ActionMethodsOf<TActions extends Record<string, ActionSpec>> = {
  readonly [K in Extract<keyof TActions, string>]: ActionMethodOf<TActions[K]>
}

type RuntimeEventReducer<TValue> = (value: TValue | null, payload: unknown) => TValue

type SessionState<TValue, TActions extends Record<string, ActionSpec>> = {
  readonly value: TValue | null
  readonly status: SessionStatus
  readonly error: SessionError | null
  readonly processing: ActionProcessing<TActions>
  readonly errors: ActionErrors<TActions>
  readonly timeouts: ActionTimeouts<TActions>
}

type SessionReadable<TValue, TActions extends Record<string, ActionSpec>> = {
  subscribe(listener: (value: SessionState<TValue, TActions>) => void): () => void
}

type SessionConfig<TSpec extends SessionSpec> = {
  topic: string
  value?: ValueOf<TSpec> | null
  connect?: {
    ok?: (value: Readonly<ValueOf<TSpec>> | null, reply: ConnectOkOf<TSpec>) => ValueOf<TSpec>
    error?: (reply: ConnectErrorOf<TSpec>) => unknown
    timeout?: () => unknown
  }
  events?: Partial<{
    [K in keyof EventMapOf<TSpec>]: (
      value: Readonly<ValueOf<TSpec>> | null,
      payload: EventMapOf<TSpec>[K],
    ) => ValueOf<TSpec>
  }>
}

type SessionCore<TSpec extends SessionSpec> = SessionReadable<
  ValueOf<TSpec>,
  ActionMapOf<TSpec>
> & {
  push<TEvent extends Extract<keyof ActionMapOf<TSpec>, string>>(
    event: TEvent,
    payload: ActionPayloadOf<ActionMapOf<TSpec>, TEvent>,
    timeout?: number,
  ): Push
  push(event: string, payload: object, timeout?: number): Push
}

type Session<TSpec extends SessionSpec> = SessionCore<TSpec> & {
  extend<TExtension extends object>(
    defineExtension: (
      session: SessionCore<TSpec>,
    ) => TExtension & ActionMethodsOf<ActionMapOf<TSpec>>,
  ): SessionReadable<ValueOf<TSpec>, ActionMapOf<TSpec>> &
    TExtension &
    ActionMethodsOf<ActionMapOf<TSpec>>
}

export function session<TSpec extends SessionSpec>(
  socket: Pick<Socket, "channel">,
  config: SessionConfig<TSpec>,
): Session<TSpec> {
  let channel: Channel | null = null
  let activeActionName: string | null = null
  let nextActionRunId = 0
  const activeActionRunIds = new Map<string, number>()

  const initialState: SessionState<ValueOf<TSpec>, ActionMapOf<TSpec>> = {
    value: config.value ?? null,
    status: config.value == null ? "loading" : "ready",
    error: null,
    processing: {} as ActionProcessing<ActionMapOf<TSpec>>,
    errors: {} as ActionErrors<ActionMapOf<TSpec>>,
    timeouts: {} as ActionTimeouts<ActionMapOf<TSpec>>,
  }

  const $state = atom<SessionState<ValueOf<TSpec>, ActionMapOf<TSpec>>>(initialState)

  const update = (
    reduce: (
      current: SessionState<ValueOf<TSpec>, ActionMapOf<TSpec>>,
    ) => SessionState<ValueOf<TSpec>, ActionMapOf<TSpec>>,
  ) => {
    $state.set(reduce($state.get()))
  }

  const registerAction = (action: string) => {
    update((current) => {
      if (action in current.processing && action in current.errors && action in current.timeouts) {
        return current
      }

      return {
        ...current,
        processing: { ...current.processing, [action]: false },
        errors: { ...current.errors, [action]: {} },
        timeouts: { ...current.timeouts, [action]: false },
      }
    })
  }

  const runAction = <TResult>(action: string, run: () => TResult) => {
    const previousActionName = activeActionName
    activeActionName = action

    try {
      return run()
    } finally {
      activeActionName = previousActionName
    }
  }

  const startPush = (action: string) => {
    const runId = ++nextActionRunId
    activeActionRunIds.set(action, runId)
    update((current) => ({
      ...current,
      processing: { ...current.processing, [action]: true },
      errors: { ...current.errors, [action]: {} },
      timeouts: { ...current.timeouts, [action]: false },
    }))
    return runId
  }

  const resolvePush = (
    action: string,
    runId: number,
    result: Pick<
      SessionState<ValueOf<TSpec>, ActionMapOf<TSpec>>,
      "processing" | "errors" | "timeouts"
    >,
  ) => {
    if (activeActionRunIds.get(action) !== runId) {
      return
    }

    activeActionRunIds.delete(action)
    update((current) => ({
      ...current,
      ...result,
    }))
  }

  onMount($state, () => {
    channel = socket.channel(config.topic, {})
    const cleanups: Array<() => void> = []

    const errorRef = channel.onError((reason) => {
      update((current) => ({
        ...current,
        status: current.value === null ? "failed" : "stale",
        error: { kind: "transport_error", cause: reason },
      }))
    })
    cleanups.push(() => channel?.off(CHANNEL_ERROR_EVENT, errorRef))

    const closeRef = channel.onClose(() => {
      update((current) => ({
        ...current,
        status: current.value === null ? "failed" : "stale",
        error: { kind: "transport_close" },
      }))
    })

    cleanups.push(() => channel?.off(CHANNEL_CLOSE_EVENT, closeRef))

    for (const [event, reducer] of Object.entries(config.events ?? {})) {
      const reduce = reducer as RuntimeEventReducer<ValueOf<TSpec>>
      const ref = channel.on(event, (payload) => {
        update((current) => ({
          ...current,
          value: reduce(current.value, payload),
          status: "ready",
          error: null,
        }))
      })
      cleanups.push(() => channel?.off(event, ref))
    }

    channel
      .join()
      .receive("ok", (response: ConnectOkOf<TSpec>) => {
        update((current) => ({
          ...current,
          value: config.connect?.ok
            ? config.connect.ok(current.value, response)
            : (response as ValueOf<TSpec>),
          status: "ready",
          error: null,
        }))
      })
      .receive("error", (response: ConnectErrorOf<TSpec>) => {
        update((current) => ({
          ...current,
          status: "failed",
          error: {
            kind: "connect_error",
            cause: config.connect?.error ? config.connect.error(response) : response,
          },
        }))
      })
      .receive("timeout", () => {
        update((current) => ({
          ...current,
          status: "failed",
          error: {
            kind: "connect_timeout",
            cause: config.connect?.timeout?.(),
          },
        }))
      })

    return () => {
      for (const cleanup of cleanups) cleanup()
      channel?.leave()
      channel = null
    }
  })

  const sessionCore: SessionCore<TSpec> = {
    subscribe: (listener) => $state.subscribe(listener),
    push: (event: string, payload: object, timeout?: number) => {
      if (!channel) {
        throw new Error(`Cannot push "${event}" before joining "${config.topic}"`)
      }

      const push = channel.push(event, payload, timeout)
      const action = activeActionName ?? event
      const runId = startPush(action)

      push
        .receive("ok", () => {
          resolvePush(action, runId, {
            processing: { ...$state.get().processing, [action]: false },
            errors: { ...$state.get().errors, [action]: {} },
            timeouts: { ...$state.get().timeouts, [action]: false },
          })
        })
        .receive("error", (response) => {
          resolvePush(action, runId, {
            processing: { ...$state.get().processing, [action]: false },
            errors: { ...$state.get().errors, [action]: response ?? {} },
            timeouts: { ...$state.get().timeouts, [action]: false },
          })
        })
        .receive("timeout", () => {
          resolvePush(action, runId, {
            processing: { ...$state.get().processing, [action]: false },
            errors: { ...$state.get().errors, [action]: {} },
            timeouts: { ...$state.get().timeouts, [action]: true },
          })
        })

      return push
    },
  }

  return {
    ...sessionCore,
    extend(defineExtension) {
      const extension = defineExtension(sessionCore)
      const wrappedExtension = { ...extension } as Record<string, unknown>

      for (const [action, value] of Object.entries(extension)) {
        if (typeof value !== "function") {
          continue
        }

        registerAction(action)

        wrappedExtension[action] = function (this: unknown, ...args: unknown[]) {
          return runAction(action, () => value.apply(this, args))
        }
      }

      return {
        ...(wrappedExtension as typeof extension),
        subscribe: sessionCore.subscribe,
      }
    },
  }
}
