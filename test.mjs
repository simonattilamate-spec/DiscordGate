import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunks, formatMessage, openStore, deliverOne } from './core.mjs';

const message = { id: '123', source: '456', author: 'Peti', channel: 'chat', createdAt: '2026-10-08T16:00:00Z', content: 'Szia @everyone 😀', attachments: [], url: 'https://discord.com/channels/1/456/123' };
const config = { base: 'https://api.fluxer.app/v1', token: 'test-placeholder' };

test('Unicode szöveg felosztása veszteség nélkül; nincs aktív everyone ping', () => {
  const original = '😀'.repeat(4000);
  assert.equal(chunks(original).join(''), original);
  assert.ok(chunks(original).every(s => s.length <= 1900 && !/[\uD800-\uDBFF]$/.test(s)));
  assert.ok(formatMessage(message)[0].includes('@\u200beveryone'));
});

test('Mentés, ismételt Discord-esemény kiszűrése, újraindítás utáni folytatás', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const file = join(dir, 'test.sqlite');
  let store;
  try {
    store = openStore(file);
    assert.equal(store.enqueue(message, '789'), true);
    assert.equal(store.enqueue(message, '789'), false);
    store.close();
    store = openStore(file);
    assert.equal(store.next().message_id, '123');
    await deliverOne(store, config, async (url, options) => {
      assert.equal(url, 'https://api.fluxer.app/v1/channels/789/messages');
      assert.deepEqual(JSON.parse(options.body).allowed_mentions.parse, []);
      return new Response(JSON.stringify({ id: '999' }), { status: 200 });
    });
    assert.equal(store.next(), undefined);
    assert.equal(store.db.prepare('SELECT fluxer_id FROM outbox').get().fluxer_id, '999');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('429 után megmarad a sor, kivárja a Retry-After értéket, nem előz a következő üzenet', async () => {
  const store = openStore(':memory:');
  try {
    store.enqueue(message, '789');
    store.enqueue({ ...message, id: '124' }, '789');
    const before = Date.now();
    await deliverOne(store, config, async () => new Response(JSON.stringify({ retry_after: 10 }), { status: 429, headers: { 'Retry-After': '12' } }));
    assert.equal(store.next(), undefined);
    const row = store.db.prepare('SELECT * FROM outbox ORDER BY seq LIMIT 1').get();
    assert.equal(row.status, 'pending');
    assert.ok(row.next_at >= before + 12000);
    assert.equal(store.next(row.next_at).message_id, '123');
  } finally { store.close(); }
});

test('Hálózati hiba és 403 újrapróbálható; 400 megőrzött, kézzel újraindítható hiba', async () => {
  for (const status of [0, 403, 400]) {
    const store = openStore(':memory:');
    try {
      store.enqueue(message, '789');
      await deliverOne(store, config, async () => {
        if (!status) throw new TypeError('fetch failed');
        return new Response('{}', { status });
      });
      const row = store.db.prepare('SELECT * FROM outbox').get();
      assert.equal(row.status, status === 400 ? 'failed' : 'pending');
      if (status === 400) {
        assert.equal(store.retryFailed(), 1);
        assert.ok(store.next());
      }
    } finally { store.close(); }
  }
});

test('Hosszú üzenet elküldött részei nem kerülnek újra a sorba', async () => {
  const store = openStore(':memory:');
  try {
    store.enqueue({ ...message, content: 'x'.repeat(5000) }, '789');
    await deliverOne(store, config, async () => new Response('{"id":"999"}', { status: 200 }));
    assert.equal(store.next().part, 1);
    assert.equal(store.enqueue({ ...message, content: 'x'.repeat(5000) }, '789'), false);
    assert.equal(store.next().part, 1);
  } finally { store.close(); }
});

test('Mindkét irányban kizárja a saját botot, más botokat és webhookokat', async () => {
  const { shouldForward } = await import('./relay.mjs');
  const human = { channelId: 'chan', author: { id: 'human', bot: false }, type: 0 };
  assert.equal(shouldForward(human, 'chan', 'self'), true);
  assert.equal(shouldForward(human, 'other', 'self'), false);
  assert.equal(shouldForward({ ...human, author: { id: 'self', bot: false } }, 'chan', 'self'), false);
  assert.equal(shouldForward({ ...human, author: { id: 'bot', bot: true } }, 'chan', 'self'), false);
  assert.equal(shouldForward({ ...human, webhookId: 'hook' }, 'chan', 'self'), false);
  assert.equal(shouldForward({ ...human, type: 7 }, 'chan', 'self'), false);
});

test('Fluxer → Discord ugyanazzal a mentéssel, helyes végponttal és platformnévvel', async () => {
  const store = openStore(':memory:');
  try {
    store.enqueue({ ...message, platform: 'Fluxer', url: '' }, '789');
    await deliverOne(store, { base: 'https://discord.com/api/v10', token: 'test', platform: 'Discord' }, async (url, options) => {
      assert.equal(url, 'https://discord.com/api/v10/channels/789/messages');
      const body = JSON.parse(options.body);
      assert.ok(body.content.includes('Fluxer #chat'));
      assert.ok(!body.content.includes('Eredeti üzenet:'));
      assert.deepEqual(body.allowed_mentions.parse, []);
      return new Response('{"id":"1000"}', { status: 200 });
    });
    assert.equal(store.next(), undefined);
  } finally { store.close(); }
});

test('Az egyik irány hibája nem akadályozza a másikat; azonos ID-k külön tárolódnak', async () => {
  const first = openStore(':memory:');
  const second = openStore(':memory:');
  try {
    assert.equal(first.enqueue(message, '789'), true);
    assert.equal(second.enqueue({ ...message, platform: 'Fluxer' }, '456'), true);
    await deliverOne(first, config, async () => new Response('{}', { status: 403 }));
    await deliverOne(second, { ...config, platform: 'Discord' }, async () => new Response('{"id":"1000"}', { status: 200 }));
    assert.equal(first.db.prepare('SELECT status FROM outbox').get().status, 'pending');
    assert.equal(second.db.prepare('SELECT status FROM outbox').get().status, 'sent');
  } finally { first.close(); second.close(); }
});
