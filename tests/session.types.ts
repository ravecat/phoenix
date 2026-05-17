import type { Socket } from "phoenix"
import { session } from "../src"

type RoomSpec = {
  value: { started: boolean }
  connect: {
    ok: { started: boolean }
    error: { reason?: string }
  }
  events: {
    projection: { started: boolean }
  }
  actions: {
    start: {
      payload: { mode: "solo" | "party" }
      ok: { accepted: true }
      error: { reason?: string }
      blocked: { reason: string }
    }
    stop: {
      error: { reason?: string }
    }
  }
}

declare const socket: Pick<Socket, "channel">

const room = session<RoomSpec>(socket, {
  topic: "room:lobby",
  connect: {
    ok: (_value, reply) => reply,
  },
  events: {
    projection: (_value, payload) => payload,
  },
}).extend(({ push }) => ({
  start(payload) {
    return push("start", payload)
  },
  stop() {
    return push("stop", {})
  },
}))

room.start({ mode: "solo" })
room.stop()

room.subscribe((state) => {
  state.processing.start
  state.errors.start.reason
  state.timeouts.start

  // @ts-expect-error unknown action bucket
  state.processing.start2

  // @ts-expect-error unknown action bucket
  state.errors.start2

  // @ts-expect-error unknown action bucket
  state.timeouts.start2
})

// @ts-expect-error invalid payload option
room.start({ mode: "duo" })

// @ts-expect-error missing payload
room.start()

// @ts-expect-error stop has no payload
room.stop({})

// @ts-expect-error extended store exposes only subscribe and action methods
room.push("dynamic_event", {})
