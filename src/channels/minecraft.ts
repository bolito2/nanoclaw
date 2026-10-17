/**
 * Minecraft channel adapter (v2) — native WebSocket bridge.
 *
 * The `mcbridge` server-only NeoForge mod (github.com/bolito2/modpackagent,
 * minecraft-bridge/) connects OUT to this adapter's WebSocket server, so the
 * game host needs no open ports. Protocol (JSON text frames):
 *
 *   mod → adapter:
 *     {type:"hello", token, server, mod_version}        must be first; bad token → close 4001
 *     {type:"chat", id, ts, player:{name,uuid}, text}  every public chat line
 *     {type:"event", ts, kind, player?, text}          join/leave/death/advancement/server_stop
 *     {type:"command", name:"reset", player}           /reiro reset (ops)
 *     {type:"player", reply_to, online, …}             answer to get_player
 *   adapter → mod:
 *     {type:"hello_ok"} · {type:"say", text} · {type:"status", text} · {type:"get_player", id, player}
 *
 * One messaging group per Minecraft server: platform_id = the mod's
 * `server_name`. All chat and events are inbound; lines matching the trigger
 * (default `@reiro`) are flagged isMention, so a wiring with engage_mode
 * 'mention' + ignored_message_policy 'accumulate' answers only questions but
 * sees the whole conversation. Questions get one compact line of the asking
 * player's state (position, held item, …), fetched with get_player.
 *
 * `/reiro reset` arrives as `/clear` from the fixed sender `minecraft:server`;
 * grant that user admin on the agent group for it to take effect.
 */
import crypto from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';

/** Close code telling the mod its token is wrong (it then backs off to 60 s). */
const CLOSE_UNAUTHORIZED = 4001;
const HELLO_TIMEOUT_MS = 10_000;
const PLAYER_TIMEOUT_MS = 1_500;
const PING_INTERVAL_MS = 30_000;
/** Minimum gap between status lines in chat (typing refreshes are frequent). */
const STATUS_MIN_GAP_MS = 20_000;
export const SERVER_SENDER_ID = 'minecraft:server';

/**
 * Public game chat: anyone on the server may talk to the agent ('public');
 * the mod tells us which lines address the bot ('platform' mentions), so the
 * default wiring engages on mentions only. No threads.
 */
const MINECRAFT_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

export interface MinecraftAdapterOptions {
  port: number;
  host: string;
  token: string;
  trigger: RegExp;
  attachContext: boolean;
}

interface ServerConn {
  ws: WebSocket;
  platformId: string;
  alive: boolean;
  lastStatusAt: number;
  lastStatus: string | null;
  pending: Map<string, (info: Record<string, unknown> | null) => void>;
}

function createMinecraftAdapter(opts: MinecraftAdapterOptions): ChannelAdapter {
  let wss: WebSocketServer | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let setupConfig: ChannelSetup | null = null;
  const servers = new Map<string, ServerConn>();
  let nextId = 0;

  function send(conn: ServerConn, msg: Record<string, unknown>): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  function tokenMatches(given: unknown): boolean {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(opts.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function inbound(conn: ServerConn, msg: InboundMessage): void {
    if (!setupConfig) return;
    Promise.resolve()
      .then(() => setupConfig!.onInbound(conn.platformId, null, msg))
      .catch((err: unknown) => log.error('Minecraft onInbound failed', { err }));
  }

  function message(text: string, sender: string, senderId: string, isMention: boolean): InboundMessage {
    return {
      id: `mc-${Date.now()}-${++nextId}`,
      kind: 'chat',
      content: { text, sender, senderId },
      timestamp: new Date().toISOString(),
      isMention,
      isGroup: true,
    };
  }

  /** Ask the mod what a player is doing; null on timeout or if offline. */
  function getPlayer(conn: ServerConn, name: string): Promise<Record<string, unknown> | null> {
    const id = `p-${++nextId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        resolve(null);
      }, PLAYER_TIMEOUT_MS);
      conn.pending.set(id, (info) => {
        clearTimeout(timer);
        resolve(info);
      });
      send(conn, { type: 'get_player', id, player: name });
    });
  }

  async function handleChat(conn: ServerConn, msg: Record<string, unknown>): Promise<void> {
    const player = (msg.player ?? {}) as { name?: string; uuid?: string };
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (!text || !player.name) return;
    const isMention = opts.trigger.test(text);
    let body = text;
    if (isMention && opts.attachContext) {
      const info = await getPlayer(conn, player.name);
      if (info?.online) body += `\n${describePlayer(info)}`;
    }
    inbound(conn, message(body, player.name, `minecraft:${player.uuid ?? player.name}`, isMention));
  }

  function handleMessage(conn: ServerConn, raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      log.warn('Minecraft: ignoring non-JSON frame', { platformId: conn.platformId });
      return;
    }
    switch (msg.type) {
      case 'chat':
        void handleChat(conn, msg);
        break;
      case 'event':
        if (typeof msg.text === 'string' && msg.text) {
          inbound(conn, message(`[event] ${msg.text}`, 'server', SERVER_SENDER_ID, false));
        }
        break;
      case 'command':
        if (msg.name === 'reset') inbound(conn, message('/clear', 'server', SERVER_SENDER_ID, true));
        break;
      case 'player': {
        const resolve = typeof msg.reply_to === 'string' ? conn.pending.get(msg.reply_to) : undefined;
        if (resolve) {
          conn.pending.delete(msg.reply_to as string);
          resolve(msg);
        }
        break;
      }
      default:
        log.debug('Minecraft: ignoring frame', { type: msg.type });
    }
  }

  function handleConnection(ws: WebSocket): void {
    const helloTimer = setTimeout(() => ws.close(CLOSE_UNAUTHORIZED, 'hello timeout'), HELLO_TIMEOUT_MS);
    ws.once('message', (data) => {
      clearTimeout(helloTimer);
      let hello: Record<string, unknown>;
      try {
        hello = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        hello = {};
      }
      if (hello.type !== 'hello' || !tokenMatches(hello.token)) {
        log.warn('Minecraft: rejected connection (bad hello or token)');
        ws.close(CLOSE_UNAUTHORIZED, 'bad token');
        return;
      }
      const platformId = typeof hello.server === 'string' && hello.server ? hello.server : 'minecraft';
      servers.get(platformId)?.ws.close(1000, 'superseded');
      const conn: ServerConn = {
        ws,
        platformId,
        alive: true,
        lastStatusAt: 0,
        lastStatus: null,
        pending: new Map(),
      };
      servers.set(platformId, conn);
      send(conn, { type: 'hello_ok' });
      setupConfig?.onMetadata(platformId, `Minecraft: ${platformId}`, true);
      log.info('Minecraft server connected', { platformId, modVersion: hello.mod_version });

      ws.on('message', (frame) => handleMessage(conn, frame.toString()));
      ws.on('pong', () => (conn.alive = true));
      ws.on('close', () => {
        if (servers.get(platformId) === conn) servers.delete(platformId);
        for (const resolve of conn.pending.values()) resolve(null);
        log.info('Minecraft server disconnected', { platformId });
      });
    });
    ws.on('error', (err) => log.warn('Minecraft socket error', { err }));
  }

  return {
    name: 'minecraft',
    channelType: 'minecraft',
    supportsThreads: false,
    defaults: MINECRAFT_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      setupConfig = config;
      wss = new WebSocketServer({ port: opts.port, host: opts.host });
      wss.on('connection', handleConnection);
      await new Promise<void>((resolve, reject) => {
        wss!.once('error', reject);
        wss!.once('listening', () => {
          log.info('Minecraft channel listening', { host: opts.host, port: opts.port });
          resolve();
        });
      });
      pingTimer = setInterval(() => {
        for (const conn of servers.values()) {
          if (!conn.alive) {
            conn.ws.terminate();
            continue;
          }
          conn.alive = false;
          conn.ws.ping();
        }
      }, PING_INTERVAL_MS);
    },

    async teardown(): Promise<void> {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      for (const conn of servers.values()) conn.ws.close(1001, 'agent stopping');
      servers.clear();
      if (wss) await new Promise<void>((resolve) => wss!.close(() => resolve()));
      wss = null;
    },

    isConnected(): boolean {
      return wss !== null;
    },

    async deliver(platformId: string, _threadId: string | null, msg: OutboundMessage): Promise<string | undefined> {
      const conn = servers.get(platformId);
      const text = extractText(msg.content);
      if (!conn || !text) return undefined;
      send(conn, { type: 'say', text });
      conn.lastStatus = null;
      conn.lastStatusAt = 0;
      return undefined;
    },

    async setTyping(platformId: string, _threadId: string | null, status?: string): Promise<void> {
      const conn = servers.get(platformId);
      if (!conn) return;
      const text = status?.trim() || 'thinking…';
      const now = Date.now();
      // Chat lines can't be edited, so only post a status when it says something
      // new and not more often than every STATUS_MIN_GAP_MS.
      if (text === conn.lastStatus || now - conn.lastStatusAt < STATUS_MIN_GAP_MS) return;
      conn.lastStatus = text;
      conn.lastStatusAt = now;
      send(conn, { type: 'status', text });
    },
  };
}

/** One compact line of player state, attached to questions only. */
export function describePlayer(info: Record<string, unknown>): string {
  const parts: string[] = [];
  const dim = typeof info.dimension === 'string' ? info.dimension.replace(/^minecraft:/, '') : null;
  const pos = Array.isArray(info.pos) ? `(${info.pos.join(', ')})` : '';
  if (dim) parts.push(`in ${dim} ${pos}`.trim());
  if (typeof info.biome === 'string') parts.push(`biome ${info.biome}`);
  if (typeof info.held === 'string') {
    const count = typeof info.held_count === 'number' && info.held_count > 1 ? `${info.held_count}× ` : '';
    parts.push(`holding ${count}${info.held_name ?? info.held} (${info.held})`);
  }
  if (typeof info.looking_at === 'string') parts.push(`looking at ${info.looking_at}`);
  if (typeof info.health === 'number') parts.push(`health ${info.health}/20`);
  return `[player state: ${parts.join(' · ')}]`;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const c = content as { text?: unknown };
    if (typeof c.text === 'string') return c.text;
  }
  return '';
}

/** `(?i)` prefixes (Java style, as in the mod's config) become the JS `i` flag. */
export function parseTrigger(source: string): RegExp {
  const caseless = source.startsWith('(?i)');
  return new RegExp(caseless ? source.slice(4) : source, caseless ? 'i' : '');
}

registerChannelAdapter('minecraft', {
  factory: () => {
    const keys = [
      'MINECRAFT_TOKEN',
      'MINECRAFT_PORT',
      'MINECRAFT_HOST',
      'MINECRAFT_TRIGGER',
      'MINECRAFT_ATTACH_CONTEXT',
    ];
    const env = readEnvFile(keys);
    const get = (k: string) => process.env[k] || env[k];
    const token = get('MINECRAFT_TOKEN');
    if (!token) return null;
    return createMinecraftAdapter({
      token,
      port: parseInt(get('MINECRAFT_PORT') || '8787', 10),
      host: get('MINECRAFT_HOST') || '127.0.0.1',
      trigger: parseTrigger(get('MINECRAFT_TRIGGER') || '(?i)@reiro\\b'),
      attachContext: get('MINECRAFT_ATTACH_CONTEXT') !== 'false',
    });
  },
  defaults: MINECRAFT_DEFAULTS,
});

export { createMinecraftAdapter };
