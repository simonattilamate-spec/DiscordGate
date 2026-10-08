import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { Client as FluxerClient, Events as FluxerEvents } from '@fluxerjs/core';
import { openStore, deliverOne } from './core.mjs';
import { shouldForward, snapshot } from './relay.mjs';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value || value.startsWith('IDE_')) throw new Error(`Töltsd ki a .env fájlban: ${name}`);
  return value;
}

function report(error, context) {
  let detail = String(error?.message || 'Ismeretlen hiba');
  for (const key of ['DISCORD_TOKEN', 'FLUXER_TOKEN']) {
    const token = process.env[key]?.trim();
    if (token) detail = detail.replaceAll(token, '[KITAKART TOKEN]');
  }
  console.error(`${context}: ${detail}`);
  console.error(`Hibakód: ${error?.code ?? error?.cause?.code ?? 'nincs'}; HTTP: ${error?.status ?? 'nincs'}`);
}

async function connect(client, event, token, name, loginOptions) {
  let timer;
  let onReady;
  const ready = new Promise(resolve => {
    onReady = resolve;
    client.once(event, onReady);
  });
  try {
    await Promise.race([
      (async () => { await client.login(token, loginOptions); await ready; })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name}: a csatlakozás 60 másodperc alatt nem készült el.`)), 60_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    client.off(event, onReady);
  }
}

async function main() {
  const discordToken = required('DISCORD_TOKEN');
  const fluxerToken = required('FLUXER_TOKEN');
  const discordChannelId = required('DISCORD_CHANNEL_ID');
  const fluxerChannelId = required('FLUXER_CHANNEL_ID');
  if (![discordChannelId, fluxerChannelId].every(id => /^\d{1,30}$/.test(id))) {
    throw new Error('A csatornaazonosítók csak számjegyek lehetnek.');
  }
  const base = (process.env.FLUXER_API_BASE || 'https://api.fluxer.app/v1').replace(/\/+$/, '');
  if (new URL(base).protocol !== 'https:') throw new Error('A Fluxer API címe HTTPS legyen.');

  mkdirSync('data', { recursive: true });
  // Megőrizzük a korábbi Discord → Fluxer adatbázist.
  const toFluxer = openStore('data/bridge.sqlite');
  const toDiscord = openStore('data/fluxer-to-discord.sqlite');
  const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  const fluxer = new FluxerClient({ rest: { api: base } });
  const loginAbort = new AbortController();
  let stopping = false;
  let fluxerChannelName = fluxerChannelId;
  const stop = () => { stopping = true; loginAbort.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  discord.on(Events.Error, error => report(error, 'Discord-kapcsolat'));
  fluxer.on(FluxerEvents.Error, error => report(error, 'Fluxer-kapcsolat'));

  function save(message, platform, store, target, channelName) {
    try {
      if (store.enqueue(snapshot(message, platform, channelName), target)) {
        console.log(`Elmentve [${platform}]: ${message.id}`);
      }
    } catch (error) {
      report(error, 'Mentési hiba');
      process.exitCode = 1;
      stop();
    }
  }

  discord.on(Events.MessageCreate, message => {
    if (stopping || !shouldForward(message, discordChannelId, discord.user?.id)) return;
    save(message, 'Discord', toFluxer, fluxerChannelId, message.channel?.name);
  });
  fluxer.on(FluxerEvents.MessageCreate, message => {
    if (stopping || !shouldForward(message, fluxerChannelId, fluxer.user?.id)) return;
    save(message, 'Fluxer', toDiscord, discordChannelId, message.channel?.name || fluxerChannelName);
  });

  try {
    if (process.argv.includes('--retry-failed')) {
      console.log(`Újrapróbálásra jelölve: ${toFluxer.retryFailed() + toDiscord.retryFailed()}`);
    }
    await connect(discord, Events.ClientReady, discordToken, 'Discord');
    if (stopping) return;
    console.log(`Discord-bot: ${discord.user.tag} | ${discord.user.id}`);
    console.log('Discord-szerverek:', [...discord.guilds.cache.values()].map(g => `${g.name} (${g.id})`).join(', ') || 'nincs');
    const channel = await discord.channels.fetch(discordChannelId);
    if (!channel?.guild || !channel.isTextBased() || channel.isThread()) {
      throw new Error('A Discord-csatorna legyen szerveres szöveges csatorna, ne szál.');
    }
    if (!channel.permissionsFor(discord.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      throw new Error('A Discord-botnak View Channel és Send Messages jog kell a csatornában.');
    }

    await connect(fluxer, FluxerEvents.Ready, fluxerToken, 'Fluxer', { signal: loginAbort.signal });
    if (stopping) return;
    const fluxerChannel = await fluxer.channels.fetch(fluxerChannelId);
    if (!fluxerChannel?.guildId || typeof fluxerChannel.send !== 'function') {
      throw new Error('A Fluxer-csatorna legyen elérhető szerveres szöveges csatorna.');
    }
    fluxerChannelName = fluxerChannel.name || fluxerChannelId;
    console.log(`Fluxer-bot: ${fluxer.user?.username} | ${fluxer.user?.id}`);
    console.log(`Discord #${channel.name} ↔ Fluxer #${fluxerChannelName}`);
    console.log('Fut a kétirányú híd. Leállítás: Ctrl+C. Egyszerre csak egy példányt futtass!');

    async function worker(store, config) {
      try {
        while (!stopping) {
          await deliverOne(store, config);
          await sleep(1000);
        }
      } catch (error) {
        report(error, 'Küldési sor hiba');
        process.exitCode = 1;
        stop();
      }
    }
    await Promise.all([
      worker(toFluxer, { base, token: fluxerToken, platform: 'Fluxer' }),
      worker(toDiscord, { base: 'https://discord.com/api/v10', token: discordToken, platform: 'Discord' }),
    ]);
  } finally {
    stop();
    await Promise.allSettled([discord.destroy(), fluxer.destroy()]);
    toFluxer.close();
    toDiscord.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

main().catch(error => { report(error, 'Indítási hiba'); process.exitCode = 1; });
