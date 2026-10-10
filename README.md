# Uptime monitor

Checks our websites every 8 hours and pings Slack if any of them are down. When everything is up it stays quiet.

It runs by itself on GitHub Actions, for free. No server, and your laptop doesn't need to be on.

## Adding or removing a site

Edit [`sites.json`](sites.json), on github.com is fine. Each site has a `name` and a `url`.

## Running a check right now

```bash
gh workflow run monitor.yml --repo mildlysupreme/uptime-monitor
```

Or on github.com: **Actions** tab, **Uptime monitor**, **Run workflow**.

## Setup (already done)

1. Create a Slack incoming webhook: https://api.slack.com/apps?new_app=1, **From scratch**, then **Incoming Webhooks**, switch **On**, **Add New Webhook**, pick a channel, copy the URL.
2. Store it in GitHub, pasting the URL when asked:
   ```bash
   gh secret set SLACK_WEBHOOK_URL --repo mildlysupreme/uptime-monitor
   ```
3. Send a test message:
   ```bash
   gh workflow run monitor.yml --repo mildlysupreme/uptime-monitor -f test=true
   ```

## Good to know

- Checks run at about 9:00, 17:00 and 1:00 Amsterdam time. GitHub sometimes starts scheduled jobs a bit late.
- A site that fails is checked once more 30 seconds later before Slack is pinged, so a single blip doesn't wake anyone up.
- A site that stays down is reported again on every check, every 8 hours, until it's fixed.
- Test on your own machine without posting: `node monitor.mjs --dry-run`
