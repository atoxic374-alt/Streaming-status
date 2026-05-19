# Streaming Status Control Center

Professional dashboard for managing streaming presence templates with persistence, runtime controls, and deep customization.

## Important policy and ecosystem findings (verified May 19, 2026)

After reviewing public projects and documentation, common patterns in self-hosted streaming status tools are:

- Most community tools that target user-account automation rely on direct user token login (self-bot style), not cookies.
- Some desktop Rich Presence tools avoid account-token automation by using local RPC bridges to the Discord app.
- Official Discord policy forbids automating normal user accounts (self-bots) outside OAuth2/bot API.

Because of that, this project now clearly shows runtime auth mode and cookie usage status in UI.

## What this dashboard now includes

- Multi-token configuration and persistence.
- Real runtime start/stop for the actual `index.js` process.
- Runtime telemetry: running state, PID, token count, cookie-auth flag, live logs.
- Deep streaming customization: watch URLs, big/small image pools, multi-line rotating texts, action buttons.
- Theme customization: primary color, background color, orb animation speed.
- EN/AR language switch with RTL/LTR support.

## Run

```bash
npm install
npm run dashboard
```

Open: `http://localhost:3210`

## Sources

- Discord policy on self-bots: https://support.discord.com/hc/en-us/articles/115002192352-Automated-user-accounts-self-bots-
- Discord guidelines: https://discord.com/guidelines
- Discord Rich Presence docs: https://docs.discord.com/developers/platform/rich-presence
- discord.js-selfbot-v13 ecosystem reference: https://github.com/aiko-chan-ai/discord.js-selfbot-v13
- Example community projects:
  - https://github.com/nexoslabs/discord-24-7-rich-presence
  - https://github.com/Jxyme/simple-discord-rpc
  - https://presence.swarve.xyz/
