/**
 * Tests for the v2 minecraft channel adapter: the WebSocket protocol spoken by
 * the mcbridge mod (hello/auth, chat, events, commands, get_player) and the
 * ChannelAdapter lifecycle (setup / teardown / deliver / setTyping).
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { createMinecraftAdapter, describePlayer, parseTrigger, SERVER_SENDER_ID } from './minecraft.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const TOKEN = 'test-token';

function makeSetup(): ChannelSetup & { inbound: Array<{ platformId: string; msg: InboundMessage }> } {
  const inbound: Array<{ platformId: string; msg: InboundMessage }> = [];
  return {
    inbound,
    onInbound: vi.fn((platformId: string, _thread: string | null, msg: InboundMessage) => {
      inbound.push({ platformId, msg });
    }),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** A fake mod: connects, collects frames, can answer get_player. */
class FakeMod {
  readonly frames: Array<Record<string, unknown>> = [];
  closeCode: number | null = null;
  players: Record<string, Record<string, unknown>> = {};
  private readonly ws: WebSocket;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/minecraft`);
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      this.frames.push(msg);
      if (msg.type === 'get_player') {
        const info = this.players[msg.player as string] ?? { online: false };
        this.send({ type: 'player', reply_to: msg.id, ...info });
      }
    });
    this.ws.on('close', (code) => (this.closeCode = code));
  }

  opened(): Promise<void> {
    return new Promise((resolve) => this.ws.once('open', () => resolve()));
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  async hello(token = TOKEN, server = 'friends'): Promise<void> {
    await this.opened();
    this.send({ type: 'hello', token, server, mod_version: '0.1.0' });
  }

  close(): void {
    this.ws.close();
  }
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('minecraft adapter', () => {
  let adapter: ChannelAdapter;
  let setup: ReturnType<typeof makeSetup>;
  let port: number;
  let mod: FakeMod;

  beforeEach(async () => {
    port = await getFreePort();
    setup = makeSetup();
    adapter = createMinecraftAdapter({
      port,
      host: '127.0.0.1',
      token: TOKEN,
      trigger: parseTrigger('(?i)@reiro\\b'),
      attachContext: true,
    });
    await adapter.setup(setup);
  });

  afterEach(async () => {
    mod?.close();
    await adapter.teardown();
  });

  it('accepts a valid hello and names the messaging group', async () => {
    mod = new FakeMod(port);
    await mod.hello();
    await until(() => mod.frames.some((f) => f.type === 'hello_ok'));
    expect(setup.onMetadata).toHaveBeenCalledWith('friends', 'Minecraft: friends', true);
  });

  it('closes with 4001 on a bad token', async () => {
    mod = new FakeMod(port);
    await mod.hello('wrong');
    await until(() => mod.closeCode !== null);
    expect(mod.closeCode).toBe(4001);
    expect(mod.frames).toEqual([]);
  });

  it('forwards plain chat as non-mention context', async () => {
    mod = new FakeMod(port);
    await mod.hello();
    mod.send({ type: 'chat', id: 'c1', player: { name: 'Sam', uuid: 'u-sam' }, text: 'we need iron' });
    await until(() => setup.inbound.length === 1);
    const { platformId, msg } = setup.inbound[0];
    expect(platformId).toBe('friends');
    expect(msg.isMention).toBe(false);
    expect(msg.content).toEqual({ text: 'we need iron', sender: 'Sam', senderId: 'minecraft:u-sam' });
  });

  it('flags questions as mentions and attaches the player state', async () => {
    mod = new FakeMod(port);
    mod.players.Oscar = {
      online: true,
      dimension: 'minecraft:overworld',
      pos: [10, 64, -5],
      held: 'create:wrench',
      held_name: 'Wrench',
      looking_at: 'create:crushing_wheel',
    };
    await mod.hello();
    mod.send({ type: 'chat', id: 'c2', player: { name: 'Oscar', uuid: 'u-o' }, text: '@Reiro what is this?' });
    await until(() => setup.inbound.length === 1);
    const { msg } = setup.inbound[0];
    expect(msg.isMention).toBe(true);
    const text = (msg.content as { text: string }).text;
    expect(text).toContain('@Reiro what is this?');
    expect(text).toContain('holding Wrench (create:wrench)');
    expect(text).toContain('looking at create:crushing_wheel');
  });

  it('still forwards a question when the player state times out or is offline', async () => {
    mod = new FakeMod(port);
    await mod.hello();
    mod.send({ type: 'chat', id: 'c3', player: { name: 'Ghost', uuid: 'u-g' }, text: '@reiro hi' });
    await until(() => setup.inbound.length === 1);
    expect((setup.inbound[0].msg.content as { text: string }).text).toBe('@reiro hi');
  });

  it('forwards events as server-authored context and reset as /clear', async () => {
    mod = new FakeMod(port);
    await mod.hello();
    mod.send({ type: 'event', kind: 'death', text: 'Sam was slain by Naga' });
    mod.send({ type: 'command', name: 'reset', player: { name: 'Oscar', uuid: 'u-o' } });
    await until(() => setup.inbound.length === 2);
    expect(setup.inbound[0].msg.content).toEqual({
      text: '[event] Sam was slain by Naga',
      sender: 'server',
      senderId: SERVER_SENDER_ID,
    });
    expect(setup.inbound[0].msg.isMention).toBe(false);
    expect((setup.inbound[1].msg.content as { text: string }).text).toBe('/clear');
    expect(setup.inbound[1].msg.isMention).toBe(true);
  });

  it('delivers replies as say frames and throttles status lines', async () => {
    mod = new FakeMod(port);
    await mod.hello();
    await until(() => mod.frames.some((f) => f.type === 'hello_ok'));
    await adapter.setTyping!('friends', null, 'checking the Create wiki');
    await adapter.setTyping!('friends', null, 'checking the Create wiki');
    await adapter.setTyping!('friends', null, 'something else too soon');
    await adapter.deliver('friends', null, { kind: 'chat', content: { text: 'Use [[create:crushing_wheel]]' } });
    await until(() => mod.frames.some((f) => f.type === 'say'));
    const sent = mod.frames.filter((f) => f.type !== 'hello_ok');
    expect(sent).toEqual([
      { type: 'status', text: 'checking the Create wiki' },
      { type: 'say', text: 'Use [[create:crushing_wheel]]' },
    ]);
  });

  it('ignores deliveries for servers that are not connected', async () => {
    await expect(adapter.deliver('nowhere', null, { kind: 'chat', content: { text: 'hi' } })).resolves.toBeUndefined();
  });
});

describe('minecraft helpers', () => {
  it('parses Java-style (?i) triggers', () => {
    const re = parseTrigger('(?i)@reiro\\b');
    expect(re.test('hey @REIRO')).toBe(true);
    expect(re.test('@reirox')).toBe(false);
  });

  it('describes player state compactly', () => {
    expect(
      describePlayer({ dimension: 'minecraft:the_nether', pos: [1, 2, 3], held: 'minecraft:torch', held_count: 12 }),
    ).toBe('[player state: in the_nether (1, 2, 3) · holding 12× minecraft:torch (minecraft:torch)]');
  });
});
