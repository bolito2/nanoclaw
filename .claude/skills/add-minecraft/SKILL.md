---
name: add-minecraft
description: Enable and wire the Minecraft channel. A server-only NeoForge mod (mcbridge) connects out to a local WebSocket and relays in-game chat; the agent answers @mentions in public chat.
---

# Minecraft channel

`src/channels/minecraft.ts` is already in this fork (registered in
`src/channels/index.ts`). The game side is the `mcbridge` mod from
https://github.com/bolito2/modpackagent (`minecraft-bridge/`); its README has the
wire protocol.

How it behaves:
- **One messaging group per Minecraft server.** `platform_id` is the mod's `server_name`.
- **All public chat and server events** (joins, deaths, advancements…) arrive as inbound messages. Lines matching `MINECRAFT_TRIGGER` (default `@reiro`) are flagged as mentions.
- **Questions get one `[player state: …]` line** for the asker (dimension, position, held item, looked-at block), fetched from the mod on demand. Set `MINECRAFT_ATTACH_CONTEXT=false` to turn it off.
- **Replies are posted in public chat.** The mod renders `**bold**`, `` `code` ``, bullets, links, and `[[namespace:item*count]]` as hoverable item links. Status updates show as gray lines, at most one every 20 s.
- **`/reiro reset`** in game arrives as `/clear` from user `minecraft:server`.

## Enable

Add to `.env` (the adapter stays off without a token):

```bash
MINECRAFT_TOKEN=<the token from the server's config/mcbridge-common.toml>
MINECRAFT_PORT=8787            # optional
MINECRAFT_HOST=127.0.0.1       # optional; keep loopback and put a TLS proxy (Caddy) in front on a VPS
MINECRAFT_TRIGGER=(?i)@reiro\b # optional; keep in sync with the mod's trigger_regex
```

In the mod's config, set `url` to `ws://localhost:8787/minecraft` (same machine) or `wss://<domain>/minecraft` behind a proxy.

## Wire the channel

The mod must have connected once, so the messaging group exists and is named after `server_name`. The host must be running for `ncl`.

```bash
ncl messaging-groups list                       # find the minecraft group id
ncl wirings create --messaging-group-id <mg-id> --agent-group-id <ag-id> \
  --session-mode shared --ignored-message-policy accumulate
```

- **`--ignored-message-policy accumulate`** keeps all other chat and events as background context.
- **Engage mode** defaults to `mention` (from the adapter's channel defaults). The agent answers only `@reiro` lines, inside one shared, persistent conversation for the server.

Let `/reiro reset` clear the session by making the server identity an admin of that agent group:

```bash
ncl users create --id minecraft:server --kind user --display-name "Minecraft server"   # if it doesn't exist yet
ncl roles grant --user minecraft:server --role admin --group <ag-id>
```

## Verify

```bash
pnpm exec vitest run src/channels/minecraft.test.ts src/channels/minecraft-registration.test.ts
```

In game: `/reiro status` should say `connected`, and `@reiro hello` should get a reply. If the mod logs "rejected the token", the two tokens differ.
