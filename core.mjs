import { DatabaseSync } from 'node:sqlite';

export function chunks(text, limit = 1900) {
  const result = [];
  let part = '';
  for (const character of text) {
    if (part.length + character.length > limit) {
      result.push(part);
      part = '';
    }
    part += character;
  }
  if (part) result.push(part);
  return result;
}

export function formatMessage(m) {
  // Platformok kozott ne keletkezzenek veletlen pingek.
  const neutralize = text => String(text).replaceAll('@', '@\u200b');
  const name = neutralize(m.author).replace(/[\r\n*_`~|>]/g, ' ');
  const channel = neutralize(m.channel).replace(/[\r\n*_`~|>]/g, ' ');
  const header = `**${name} • ${m.platform || 'Discord'} #${channel}**\n${m.createdAt}`;
  const body = neutralize(m.displayContent || m.content || '');
  const files = m.attachments.map(a => `${neutralize(a.name)}: ${a.url}`).join('\n');
  const content = [header, body, files].filter(Boolean).join('\n');
  return chunks(content);
}

export function openStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL,
      snapshot TEXT NOT NULL, saved_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL,
      part INTEGER NOT NULL, target TEXT NOT NULL, content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0, fluxer_id TEXT, error TEXT,
      UNIQUE(message_id, part)
    );`);
  return {
    db,
    enqueue(message, target) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const saved = db.prepare('INSERT OR IGNORE INTO messages VALUES (?, ?, ?, ?, ?)')
          .run(message.id, message.source, target, JSON.stringify(message), Date.now());
        if (saved.changes) {
          const insert = db.prepare('INSERT INTO outbox (message_id, part, target, content) VALUES (?, ?, ?, ?)');
          formatMessage(message).forEach((content, part) => insert.run(message.id, part, target, content));
        }
        db.exec('COMMIT');
        return Boolean(saved.changes);
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    next(now = Date.now()) {
      // Az elso fuggoben levo sor varakozasa alatt ne elozzek meg kesobbiek.
      const row = db.prepare("SELECT * FROM outbox WHERE status='pending' ORDER BY seq LIMIT 1").get();
      return row && row.next_at <= now ? row : undefined;
    },
    sent(seq, id) {
      db.prepare("UPDATE outbox SET status='sent', fluxer_id=?, error=NULL WHERE seq=?").run(id, seq);
    },
    retry(seq, delay, error) {
      db.prepare('UPDATE outbox SET attempts=attempts+1, next_at=?, error=? WHERE seq=?')
        .run(Date.now() + delay, error, seq);
    },
    fail(seq, error) {
      db.prepare("UPDATE outbox SET status='failed', attempts=attempts+1, error=? WHERE seq=?").run(error, seq);
    },
    retryFailed() {
      return db.prepare("UPDATE outbox SET status='pending', next_at=0 WHERE status='failed'").run().changes;
    },
    close() { db.close(); },
  };
}

export async function sendFluxer({ base, token, target, content, fetchImpl = fetch }) {
  const response = await fetchImpl(`${base}/channels/${target}/messages`, {
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [], users: [], roles: [], replied_user: false } }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Fluxer HTTP ${response.status}`);
    error.status = response.status;
    const rawHeader = response.headers.get('retry-after');
    const headerSeconds = rawHeader === null ? NaN : Number(rawHeader);
    const dateSeconds = rawHeader ? (Date.parse(rawHeader) - Date.now()) / 1000 : NaN;
    const bodySeconds = Number(body.retry_after);
    const candidates = [headerSeconds, dateSeconds, bodySeconds].filter(n => Number.isFinite(n) && n >= 0);
    error.retryMs = Math.max(1000, ...(candidates.map(n => n * 1000)));
    throw error;
  }
  if (typeof body.id !== 'string') throw new Error('Fluxer: hiányzó üzenetazonosító');
  return body.id;
}

export async function deliverOne(store, config, fetchImpl = fetch) {
  const row = store.next();
  if (!row) return false;
  try {
    const id = config.send
      ? await config.send(row.target, row.content)
      : await sendFluxer({ ...config, target: row.target, content: row.content, fetchImpl });
    store.sent(row.seq, id);
    console.log(`Átküldve → ${config.platform || 'Fluxer'}: ${row.message_id}, rész: ${row.part + 1}`);
  } catch (error) {
    // Nem naplozunk HTTP torzset vagy tokent.
    const status = error.status;
    const platform = config.platform || 'Fluxer';
    const label = status ? `${platform} HTTP ${status}` : `Hálózati hiba vagy érvénytelen ${platform}-válasz`;
    if (status >= 400 && status < 500 && ![401, 403, 404, 408, 429].includes(status)) {
      store.fail(row.seq, label);
      console.error(`${label}: ${row.message_id}. Javítás után: npm run retry-failed`);
    } else {
      const backoff = Math.min(300_000, 2000 * 2 ** Math.min(row.attempts, 8));
      const delay = status === 429 ? error.retryMs : [401, 403, 404].includes(status) ? 60_000 : backoff;
      store.retry(row.seq, delay, label);
      console.error(`${label}; újrapróbálás ${Math.ceil(delay / 1000)} mp múlva.`);
    }
  }
  return true;
}
