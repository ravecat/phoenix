import type {
  MessageRef,
  Channel as PhoenixChannel,
  Push as PhoenixPush,
  Socket as PhoenixSocket,
  PushStatus,
  SocketConnectOption,
} from "phoenix"
import { vi } from "vitest"

type MockConstructor<TArgs extends readonly unknown[], TInstance> = {
  new (...args: TArgs): TInstance
}

type PushCallback = Parameters<PhoenixPush["receive"]>[1]
type ChannelCallback = Parameters<PhoenixChannel["on"]>[1]
type ChannelErrorCallback = Parameters<PhoenixChannel["onError"]>[0]
type ChannelCloseCallback = Parameters<PhoenixChannel["onClose"]>[0]

export type MockPush = PhoenixPush & {
  channel: PhoenixChannel
  event: string
  payload: object
  timeout: number
  reply(status: PushStatus, response?: unknown): void
}

export type MockChannel = PhoenixChannel & {
  params?: object | (() => object)
  socket?: PhoenixSocket
  joinPush: MockPush
  pushes: MockPush[]
  receive(event: string, payload?: unknown): void
  error(reason?: unknown): void
  close(): void
}

export type MockSocket = PhoenixSocket & {
  endpoint: string
  options?: Partial<SocketConnectOption>
  channels: MockChannel[]
}

export const Push = vi.fn(function (
  this: MockPush,
  channel: PhoenixChannel,
  event: string,
  payload: object,
  timeout = 10_000,
) {
  const callbacks = new Map<PushStatus, PushCallback>()

  this.channel = channel
  this.event = event
  this.payload = payload
  this.timeout = timeout
  this.send = vi.fn<PhoenixPush["send"]>()
  this.resend = vi.fn<PhoenixPush["resend"]>((nextTimeout) => {
    this.timeout = nextTimeout
  })
  this.receive = vi.fn<MockPush["receive"]>((status, callback) => {
    callbacks.set(status, callback)
    return this
  })
  this.reply = (status, response) => {
    callbacks.get(status)?.(response)
  }
}) as unknown as MockConstructor<
  [channel: PhoenixChannel, event: string, payload: object, timeout?: number],
  MockPush
>

export const Channel = vi.fn(function (
  this: MockChannel,
  topic: string,
  params?: object | (() => object),
  socket?: PhoenixSocket,
) {
  let nextRef = 0
  const callbacks = new Map<string, Map<number, ChannelCallback>>()
  const errorCallbacks = new Map<number, ChannelErrorCallback>()
  const closeCallbacks = new Map<number, ChannelCloseCallback>()

  this.topic = topic
  this.params = params
  this.socket = socket
  this.state = "closed"
  this.joinPush = new Push(this, "phx_join", {})
  this.pushes = []
  this.join = vi.fn<PhoenixChannel["join"]>((timeout = 10_000) => {
    this.joinPush.timeout = timeout
    return this.joinPush
  })
  this.leave = vi.fn<PhoenixChannel["leave"]>(
    (timeout = 10_000) => new Push(this, "phx_leave", {}, timeout),
  )
  this.push = vi.fn<PhoenixChannel["push"]>((event, payload, timeout = 10_000) => {
    const push = new Push(this, event, payload, timeout)
    this.pushes.push(push)
    return push
  })
  this.on = vi.fn<PhoenixChannel["on"]>((event, callback) => {
    const ref = ++nextRef
    const eventCallbacks = callbacks.get(event) ?? new Map<number, ChannelCallback>()
    eventCallbacks.set(ref, callback)
    callbacks.set(event, eventCallbacks)
    return ref
  })
  this.off = vi.fn<PhoenixChannel["off"]>((event, ref) => {
    if (event === "phx_error") {
      ref == null ? errorCallbacks.clear() : errorCallbacks.delete(ref)
      return
    }

    if (event === "phx_close") {
      ref == null ? closeCallbacks.clear() : closeCallbacks.delete(ref)
      return
    }

    if (ref == null) {
      callbacks.delete(event)
      return
    }

    callbacks.get(event)?.delete(ref)
  })
  this.onClose = vi.fn<PhoenixChannel["onClose"]>((callback) => {
    const ref = ++nextRef
    closeCallbacks.set(ref, callback)
    return ref
  })
  this.onError = vi.fn<PhoenixChannel["onError"]>((callback) => {
    const ref = ++nextRef
    errorCallbacks.set(ref, callback)
    return ref
  })
  this.onMessage = vi.fn<PhoenixChannel["onMessage"]>((event, payload) => {
    this.receive(event, payload)
    return payload
  })
  this.receive = (event, payload) => {
    for (const callback of callbacks.get(event)?.values() ?? []) {
      callback(payload)
    }
  }
  this.error = (reason) => {
    for (const callback of errorCallbacks.values()) {
      callback(reason)
    }
  }
  this.close = () => {
    for (const callback of closeCallbacks.values()) {
      callback(undefined, undefined, undefined)
    }
  }
}) as unknown as MockConstructor<
  [topic: string, params?: object | (() => object), socket?: PhoenixSocket],
  MockChannel
>

export const Socket = vi.fn(function (
  this: MockSocket,
  endpoint: string,
  options?: Partial<SocketConnectOption>,
) {
  let nextRef = 0

  this.endpoint = endpoint
  this.options = options
  this.channels = []
  this.protocol = vi.fn<PhoenixSocket["protocol"]>(() => "ws")
  this.endPointURL = vi.fn<PhoenixSocket["endPointURL"]>(() => endpoint)
  this.connect = vi.fn<PhoenixSocket["connect"]>()
  this.disconnect = vi.fn<PhoenixSocket["disconnect"]>()
  this.connectionState = vi.fn<PhoenixSocket["connectionState"]>(() => "open")
  this.isConnected = vi.fn<PhoenixSocket["isConnected"]>(() => true)
  this.replaceTransport = vi.fn<PhoenixSocket["replaceTransport"]>()
  this.remove = vi.fn<PhoenixSocket["remove"]>()
  this.channel = vi.fn<PhoenixSocket["channel"]>((topic, params) => {
    const channel = new Channel(topic, params, this)
    this.channels.push(channel)
    return channel
  })
  this.push = vi.fn<PhoenixSocket["push"]>()
  this.log = vi.fn<PhoenixSocket["log"]>()
  this.hasLogger = vi.fn<PhoenixSocket["hasLogger"]>(() => false)
  this.onOpen = vi.fn<PhoenixSocket["onOpen"]>(() => String(++nextRef) as MessageRef)
  this.onClose = vi.fn<PhoenixSocket["onClose"]>(() => String(++nextRef) as MessageRef)
  this.onError = vi.fn<PhoenixSocket["onError"]>(() => String(++nextRef) as MessageRef)
  this.onMessage = vi.fn<PhoenixSocket["onMessage"]>(() => String(++nextRef) as MessageRef)
  this.makeRef = vi.fn<PhoenixSocket["makeRef"]>(() => String(++nextRef) as MessageRef)
  this.off = vi.fn<PhoenixSocket["off"]>()
  this.ping = vi.fn<PhoenixSocket["ping"]>(() => true)
}) as unknown as MockConstructor<
  [endpoint: string, options?: Partial<SocketConnectOption>],
  MockSocket
>
