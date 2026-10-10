# Uptime monitor

Checks our websites every 5 minutes and posts to Slack when one:

- goes **down** (error page, no response, DNS or SSL failure)
- gets **slow** (takes more than 5 seconds to respond)
- has an **SSL certificate** that expires within 14 days
- **recovers** (with how long it was down)

While a site stays down it reminds the channel once an hour. Every morning at 9:00 (Amsterdam time) it posts a short daily report, which also proves the monitor itself is still running.

It runs free on GitHub Actions. No server to pay for or look after.

## Adding or removing a site

Edit [`sites.json`](sites.json), on github.com is fine. Each site has a `name` and a `url`. Add `"keyword": "some text"` if the page should contain that text; this catches a site that loads but shows an error page with a 200 status.

## Setup

### 1. Make a Slack webhook

1. Open https://api.slack.com/apps?new_app=1 and pick **From scratch**.
2. Name it `Uptime monitor`, pick your workspace, click **Create App**.
3. In the left menu click **Incoming Webhooks**, switch it **On**.
4. Click **Add New Webhook**, pick the channel (for example `#site-alerts`), click **Allow**.
5. Copy the webhook URL. It starts with `https://hooks.slack.com/services/`. Treat it like a password: anyone with it can post in that channel.

### 2. Give the webhook to GitHub

Run this and paste the URL when it asks:

```bash
gh secret set SLACK_WEBHOOK_URL --repo mildlysupreme/uptime-monitor
```

### 3. Test it

```bash
gh workflow run monitor.yml --repo mildlysupreme/uptime-monitor -f test=true
```

A "Uptime monitor is connected" message should appear in Slack within a minute.

## Good to know

- GitHub runs scheduled jobs on a best-effort basis. Checks usually happen every 5 to 10 minutes, sometimes later when GitHub is busy. Fine for small sites; use a paid monitor if you need minute-level alerts.
- Each site gets one automatic retry 10 seconds later before anything is reported, so a single blip doesn't wake anyone up.
- `state.json` is the monitor's memory (which sites are down and since when). The workflow updates it by itself; don't edit it.
- Run it on your own machine without posting anything: `node monitor.mjs --dry-run`
