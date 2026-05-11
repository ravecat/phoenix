# @rvct/phoenix

Reactive helpers for [Phoenix channels](https://hexdocs.pm/phoenix/channels.html).

`@rvct/phoenix` wraps a Phoenix channel as a small reactive store. It joins a channel when the
store is mounted, exposes the current channel-backed state through `subscribe`, maps incoming
channel events to state reducers, and keeps `push` available for messages sent back to the
channel.

## Basic usage

```ts
import { session } from "@rvct/phoenix"
import { Socket } from "phoenix"

const socket = new Socket("/socket", {
  params: { token: window.userToken },
})

socket.connect()

const room = session(socket, {
  topic: "room:lobby",
})

const unsubscribe = room.subscribe((state) => {
  console.log(state.status, state.value, state.error)
})
```

The store state has three fields:

- `value` - the current channel state, or `null` before a value is available
- `status` - `loading`, `ready`, `stale`, or `failed`
- `error` - connection, join, transport, or close information when the session is not healthy

## Why this shape

Phoenix Channels expose a transport-oriented API through the
[Phoenix JavaScript client](https://hexdocs.pm/phoenix/js/): join a topic, receive events, push
messages, and handle channel failures. Client applications usually need a slightly different
shape. They need the transport, the latest useful state, and the connection or join error state in
one subscription surface.

`session` keeps those concerns together:

- `push` preserves direct access to channel messages sent to the server
- `value` keeps the latest state derived from the join reply and incoming events
- `status` and `error` make loading, stale transport, and failed join states explicit

That gives UI code one reactive object to subscribe to instead of coordinating a channel instance,
local cache, and error flags separately.

## Initial state

Pass `value` when the UI already has useful state before the channel join reply arrives. The
session starts as `ready` when `value` is present, otherwise it starts as `loading`.

```ts
type Message = {
  id: string
  body: string
  insertedAt: string
}

type RoomState = {
  messages: Message[]
}

const room = session<{ value: RoomState }>(socket, {
  topic: "room:lobby",
  value: {
    messages: [],
  },
})
```

## Join replies

By default, the successful join reply becomes the store value. Use `connect.ok` when the server
reply needs normalization or should merge with the current value.

```ts
type RoomSession = {
  value: RoomState
  connect: {
    ok: {
      messages: Message[]
    }
    error: {
      reason: string
    }
  }
}

const room = session<RoomSession>(socket, {
  topic: "room:lobby",
  value: {
    messages: [],
  },
  connect: {
    ok(value, reply) {
      return {
        messages: [...(value?.messages ?? []), ...reply.messages],
      }
    },
    error(reply) {
      return reply.reason
    },
  },
})
```

## Incoming channel events

`events` is the reactive equivalent of registering `channel.on(event, callback)` and then writing
the new state yourself. Each handler receives the current value and the event payload, then returns
the next value.

```ts
type RoomEvents = {
  new_msg: Message
  message_updated: Message
  message_deleted: {
    id: string
  }
}

const room = session<{
  value: RoomState
  connect: {
    ok: {
      messages: Message[]
    }
  }
  events: RoomEvents
}>(socket, {
  topic: "room:lobby",
  value: {
    messages: [],
  },
  connect: {
    ok(_value, reply) {
      return {
        messages: reply.messages,
      }
    },
  },
  events: {
    new_msg(value, message) {
      return {
        messages: [...(value?.messages ?? []), message],
      }
    },
    message_updated(value, message) {
      return {
        messages: (value?.messages ?? []).map((current) =>
          current.id === message.id ? message : current,
        ),
      }
    },
    message_deleted(value, payload) {
      return {
        messages: (value?.messages ?? []).filter((message) => message.id !== payload.id),
      }
    },
  },
})
```

## Sending messages

Use `push` to send events through the joined channel. This follows the Phoenix client model where
the event name maps to `handle_in/3` on the server channel.

```ts
room.push("new_msg", {
  body: "Hello",
})
```

For a domain-specific API, extend the session and keep the reactive `subscribe` method.

```ts
const chat = room.extend((session) => ({
  sendMessage(body: string) {
    return session.push("new_msg", { body })
  },
}))

chat.sendMessage("Hello")
chat.subscribe((state) => {
  console.log(state.value?.messages)
})
```

## Lifecycle

The channel is created from `socket.channel(topic, {})` and joined when the session store is
mounted. Incoming event handlers are registered on mount and removed on unmount. When the store is
unmounted, the channel leaves and the local channel reference is cleared.

## Frontend adapters

The reactive layer is built on [nanostores](https://github.com/nanostores/nanostores). That keeps
the channel wrapper independent from a specific UI runtime and lets the same session model be used
from different client frontends, including React, Vue, Svelte, Solid, Lit, Angular, and vanilla
JavaScript.

## References

- [Phoenix Channels guide](https://hexdocs.pm/phoenix/channels.html)
- [Phoenix JavaScript client docs](https://hexdocs.pm/phoenix/js/)
- [Writing a Channels Client](https://hexdocs.pm/phoenix/writing_a_channels_client.html)
- [nanostores project](https://github.com/nanostores/nanostores)

## License

MIT
