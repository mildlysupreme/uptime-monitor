#!/usr/bin/env node
// Checks every site in sites.json and pings Slack if any of them are down.
//
//   node monitor.mjs            check, ping Slack if something is down
//   node monitor.mjs --test     send a "connected" message to Slack
//   node monitor.mjs --dry-run  check and print, don't post

import { readFile } from 'node:fs/promises';

const WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS ?? 30_000);
const args = new Set(process.argv.slice(2));

const sites = JSON.parse(await readFile('sites.json', 'utf8'));
const link = (site) => `<${site.url}|${site.name}>`;

async function probe(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; UptimeMonitor/1.0)' },
    });
    await res.body?.cancel();
    return res.ok ? null : `HTTP ${res.status} error`;
  } catch (err) {
    if (err.name === 'TimeoutError') return 'no response after 20s';
    if (err.cause?.code === 'ENOTFOUND') return "domain doesn't resolve";
    return err.cause?.message ?? err.message;
  }
}

// Check twice, 30s apart, so a single blip doesn't ping anyone.
async function check(site) {
  if (!(await probe(site.url))) return null;
  await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  return probe(site.url);
}

async function postToSlack(text) {
  if (args.has('--dry-run')) return console.log(`[dry run] would post:\n${text}`);
  if (!WEBHOOK) throw new Error('SLACK_WEBHOOK_URL is not set. See README.md.');
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, unfurl_links: false }),
  });
  if (!res.ok) throw new Error(`Slack rejected the message: HTTP ${res.status}`);
}

if (args.has('--test')) {
  await postToSlack(`:wave: Uptime monitor is connected. Watching ${sites.length} sites: ${sites.map(link).join(', ')}`);
  process.exit(0);
}

const problems = await Promise.all(sites.map(check));
const down = sites.map((site, i) => ({ site, problem: problems[i] })).filter((d) => d.problem);

for (const { site, problem } of down) console.log(`DOWN  ${site.name}: ${problem}`);
console.log(`${sites.length - down.length} of ${sites.length} sites up.`);

if (down.length) {
  const title = down.length === 1 ? '1 site is down' : `${down.length} sites are down`;
  const lines = down.map(({ site, problem }) => `• ${link(site)}: ${problem}`);
  await postToSlack(`:red_circle: *${title}*\n${lines.join('\n')}`);
}
