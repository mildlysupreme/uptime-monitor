#!/usr/bin/env node
// Checks every site in sites.json and posts to Slack when a site goes down,
// gets slow, has an expiring SSL certificate, or recovers.
//
//   node monitor.mjs            normal run (needs SLACK_WEBHOOK_URL)
//   node monitor.mjs --test     send a "connected" message to Slack
//   node monitor.mjs --dry-run  print what would be sent, change nothing

import { readFile, writeFile } from 'node:fs/promises';
import tls from 'node:tls';

const SITES_FILE = process.env.SITES_FILE ?? 'sites.json';
const STATE_FILE = process.env.STATE_FILE ?? 'state.json';
const WEBHOOK = process.env.SLACK_WEBHOOK_URL;

const TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS ?? 10_000);
const SLOW_MS = Number(process.env.SLOW_MS ?? 5_000);
const CERT_WARN_DAYS = 14;
const REMIND_MINUTES = Number(process.env.REMIND_MINUTES ?? 60);
const DIGEST_HOUR = process.env.DIGEST_HOUR ?? '9'; // set to '' to turn the daily report off
const TZ = process.env.DIGEST_TZ ?? 'Europe/Amsterdam';
const KEEP_INCIDENT_DAYS = 30;

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- checking ---------------------------------------------------------------

function describeError(err) {
  if (err.name === 'TimeoutError') return `no response after ${TIMEOUT_MS / 1000}s`;
  const code = err.cause?.code ?? err.code;
  const known = {
    ENOTFOUND: "domain doesn't resolve (DNS problem)",
    ECONNREFUSED: 'server refused the connection',
    ECONNRESET: 'connection was reset',
    CERT_HAS_EXPIRED: 'SSL certificate has expired',
    ERR_TLS_CERT_ALTNAME_INVALID: "SSL certificate doesn't match the domain",
    DEPTH_ZERO_SELF_SIGNED_CERT: 'SSL certificate is self-signed',
  };
  return known[code] ?? (code ? `${code}: ${err.cause?.message ?? err.message}` : err.message);
}

async function probe(site) {
  const started = Date.now();
  try {
    const res = await fetch(site.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; UptimeMonitor/1.0)' },
    });
    const ms = Date.now() - started;
    if (res.status >= 400) {
      await res.body?.cancel();
      return { kind: 'down', detail: `HTTP ${res.status} error`, ms };
    }
    if (site.keyword) {
      const body = await res.text();
      if (!body.includes(site.keyword)) {
        return { kind: 'down', detail: `page loaded but "${site.keyword}" is missing`, ms };
      }
    } else {
      await res.body?.cancel();
    }
    if (ms > SLOW_MS) return { kind: 'slow', detail: `took ${(ms / 1000).toFixed(1)}s to respond`, ms };
    return { kind: 'up', ms };
  } catch (err) {
    return { kind: 'down', detail: describeError(err), ms: Date.now() - started };
  }
}

function certDaysLeft(url) {
  const { hostname, protocol, port } = new URL(url);
  if (protocol !== 'https:') return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port: Number(port) || 443, servername: hostname, timeout: 10_000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        resolve(cert?.valid_to ? Math.floor((new Date(cert.valid_to) - Date.now()) / 86_400_000) : null);
      },
    );
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

async function checkSite(site) {
  let result = await probe(site);
  // One retry before calling anything a problem, so a single blip doesn't alert.
  if (result.kind !== 'up') {
    await sleep(RETRY_DELAY_MS);
    result = await probe(site);
  }
  if (result.kind === 'up') {
    const days = await certDaysLeft(site.url);
    if (days !== null && days < CERT_WARN_DAYS) {
      result = { ...result, kind: 'cert', detail: `SSL certificate expires in ${days} day${days === 1 ? '' : 's'}` };
    }
  }
  return result;
}

// --- messages ---------------------------------------------------------------

function duration(fromIso, to = new Date()) {
  const mins = Math.max(1, Math.round((to - new Date(fromIso)) / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)} days`;
}

const link = (site) => `<${site.url}|${site.name}>`;

function transitionMessage(site, prev, now) {
  if (now.kind === 'down') return `:red_circle: *${link(site)} is DOWN*: ${now.detail}`;
  if (now.kind === 'slow') return `:large_yellow_circle: *${link(site)} is slow*: ${now.detail}`;
  if (now.kind === 'cert') return `:warning: *${link(site)}*: ${now.detail}`;
  // now.kind === 'up'
  if (prev.kind === 'down') return `:large_green_circle: *${link(site)} is back up* after ${duration(prev.since)} (was: ${prev.detail})`;
  if (prev.kind === 'slow') return `:large_green_circle: *${link(site)}* is responding normally again`;
  if (prev.kind === 'cert') return `:large_green_circle: *${link(site)}*: SSL certificate has been renewed`;
  return null;
}

function localParts(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function digestMessage(sites, results, state, now) {
  const icon = { up: ':white_check_mark:', slow: ':large_yellow_circle:', cert: ':warning:', down: ':red_circle:' };
  const lines = sites.map((site, i) => {
    const r = results[i];
    const s = state.sites[site.url];
    const info = r.kind === 'up' ? `up (${(r.ms / 1000).toFixed(1)}s)` : `${r.detail}${s?.since ? `, since ${duration(s.since, now)} ago` : ''}`;
    return `${icon[r.kind]} ${link(site)}: ${info}`;
  });
  const dayAgo = now - 86_400_000;
  const recent = state.incidents.filter((inc) => new Date(inc.start) >= dayAgo || !inc.end || new Date(inc.end) >= dayAgo);
  const summary = recent.length
    ? `${recent.length} incident${recent.length === 1 ? '' : 's'} in the last 24 hours.`
    : 'No incidents in the last 24 hours.';
  return `:bar_chart: *Daily uptime report*\n${lines.join('\n')}\n_${summary}_`;
}

async function postToSlack(text) {
  if (DRY_RUN) {
    console.log(`[dry run] would post to Slack:\n${text}\n`);
    return;
  }
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
  });
  if (!res.ok) throw new Error(`Slack rejected the message: HTTP ${res.status} ${await res.text()}`);
}

// --- main -------------------------------------------------------------------

const sites = JSON.parse(await readFile(SITES_FILE, 'utf8'));

// Not set up yet: skip quietly instead of failing every 5 minutes. Nothing is
// saved, so the first real run still reports whatever is down.
if (!WEBHOOK && !DRY_RUN) {
  console.log('SLACK_WEBHOOK_URL is not set yet, skipping. See README.md, step 2.');
  process.exit(0);
}

if (args.has('--test')) {
  await postToSlack(`:wave: Uptime monitor is connected. Watching ${sites.length} sites: ${sites.map(link).join(', ')}`);
  console.log('Test message sent.');
  process.exit(0);
}

const before = await readFile(STATE_FILE, 'utf8').catch(() => null);
const state = before ? JSON.parse(before) : { sites: {}, incidents: [], lastDigest: null };
const now = new Date();
const results = await Promise.all(sites.map(checkSite));
const messages = [];

sites.forEach((site, i) => {
  const r = results[i];
  console.log(`${site.name.padEnd(24)} ${r.kind.padEnd(5)} ${String(r.ms).padStart(6)}ms ${r.detail ?? ''}`);
  const prev = state.sites[site.url] ?? { kind: 'up' };

  if (r.kind !== prev.kind) {
    const msg = transitionMessage(site, prev, r);
    if (msg) messages.push(msg);
    const open = state.incidents.find((inc) => inc.url === site.url && !inc.end);
    if (open) open.end = now.toISOString();
    if (r.kind === 'up') {
      delete state.sites[site.url];
    } else {
      state.sites[site.url] = { kind: r.kind, detail: r.detail, since: now.toISOString(), lastAlert: now.toISOString() };
      state.incidents.push({ url: site.url, name: site.name, kind: r.kind, detail: r.detail, start: now.toISOString() });
    }
  } else if (r.kind === 'down' && now - new Date(prev.lastAlert) >= REMIND_MINUTES * 60_000) {
    messages.push(`:red_circle: *${link(site)} is still down* (for ${duration(prev.since, now)}): ${r.detail}`);
    prev.lastAlert = now.toISOString();
  }
});

// Forget sites that were removed from sites.json, and old incidents.
const watched = new Set(sites.map((s) => s.url));
for (const url of Object.keys(state.sites)) if (!watched.has(url)) delete state.sites[url];
const cutoff = now - KEEP_INCIDENT_DAYS * 86_400_000;
state.incidents = state.incidents.filter((inc) => !inc.end || new Date(inc.end) >= cutoff);

if (DIGEST_HOUR !== '') {
  const { day, hour } = localParts(now);
  if (hour >= Number(DIGEST_HOUR) && state.lastDigest !== day) {
    messages.push(digestMessage(sites, results, state, now));
    state.lastDigest = day;
  }
}

if (messages.length) await postToSlack(messages.join('\n\n'));

// Only saved after Slack accepted the message, so a failed post is retried next run.
const after = JSON.stringify(state, null, 2) + '\n';
if (!DRY_RUN && after !== before) await writeFile(STATE_FILE, after);
