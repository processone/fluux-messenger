# Bot examples

Two runnable bots, headless: no React, no DOM, plain Node.

They exist to be run against a real server. They are also the SDK's own check
that `@fluux/sdk/core` stands on its own, so they are typechecked and linted
with the package and its built core bundle is executed in Node (`npm run
typecheck`, `npm run lint`, `npm run test:node`). An API or runtime change that
breaks headless use breaks CI, which is the point.

See the SDK's [headless usage documentation](../README.md#headless-usage-bots-cli-non-react)
for FAST token storage in Node.

## Running them

Build the SDK first, since the examples import the package entry points the
same way any consumer would:

```bash
npm run build:sdk
```

Then, from `packages/fluux-sdk`:

```bash
export FLUUX_JID=bot@example.com
export FLUUX_PASSWORD=secret

npx tsx examples/notifier.ts user@example.com "build 412 is green"
npx tsx examples/assistant.ts
npx tsx examples/assistant.ts room@conference.example.com
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `FLUUX_JID` | yes | The bot's account, `local@domain` |
| `FLUUX_PASSWORD` | yes | Its password |
| `FLUUX_SERVER` | no | WebSocket endpoint, e.g. `wss://example.com:5443/ws`. Discovered from the domain when unset |
| `FLUUX_DEBUG` | no | `1` to see every SDK diagnostic, not just warnings and errors |

The SDK connects over WebSocket only. A server that publishes no XEP-0156
host-meta will need `FLUUX_SERVER` set by hand, and the standard client TCP
port is not an option.

## `notifier.ts`

Connects, sends one message, disconnects. The smallest useful bot: a CI job
reporting somewhere. It never reads a message, so it never touches the stores.

## `assistant.ts`

A bot that answers slowly, which is the shape of anything backed by a real
service. Replying to a direct message, or to a mention in a room, it:

1. reacts 👀 to the question, so the asker knows it landed
2. shows `composing` while it works
3. posts a placeholder as a reply to the question
4. edits that placeholder into the answer when the work finishes

Step 4 is the interesting one. Correcting the placeholder leaves one message
that turns into the answer, instead of a placeholder followed by a second
message that pushes it out of view.

Replace `answer()` with a call to whatever actually produces the reply.
