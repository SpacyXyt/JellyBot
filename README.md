# Jellyfin Discord Subscription Bot

Bot Discord + Stripe + Jellyfin + PostgreSQL, designed for a private Jellyfin server reachable from a VPS through WireGuard.

> Use this only for media and services you are authorized to manage and distribute.

## Architecture

```text
Discord
   |
   v
Bot + Stripe webhook
   |
   | private WireGuard
   v
Home server -> Jellyfin
```

The VPS stack contains:

- WireGuard
- Discord/Stripe bot
- PostgreSQL
- Caddy HTTPS reverse proxy

The bot and PostgreSQL share the WireGuard network namespace. PostgreSQL listens only on `127.0.0.1`, so it is not published to the Internet.

## Repository

Push the whole repository to GitHub.

GitHub Actions builds and publishes:

`ghcr.io/<github-user>/jellyfin-discord-subscription-bot:latest`

## Portainer

For a Portainer Git Stack, use this repository as the stack repository.

If you want Portainer to pull the published image instead of building locally, change the `bot` service from:

```yaml
build:
  context: .
  dockerfile: Dockerfile
```

to:

```yaml
image: ghcr.io/YOUR_GITHUB_USER/jellyfin-discord-subscription-bot:latest
```

## Secrets

Do not commit `.env`, Stripe secrets, Discord tokens, Jellyfin API keys, or WireGuard private keys.

Copy `.env.example` to `.env` on the VPS and fill it in.

## WireGuard

Create:

`wireguard/wg_confs/wg0.conf`

Do not commit this file.

Example topology:

- VPS: `10.50.0.1`
- Home server: `10.50.0.2`
- Jellyfin: `http://10.50.0.2:8096`

Use split routing rather than `0.0.0.0/0` unless you specifically need a full-tunnel VPN.

For a home peer behind NAT, `PersistentKeepalive = 25` is commonly useful.

## Caddy

Set `PUBLIC_DOMAIN` to the real hostname used by your Stripe webhook.

Stripe endpoint:

`https://YOUR_DOMAIN/webhooks/stripe`

## Jellyfin API key

Create a dedicated Jellyfin API key for this bot and give it only the permissions necessary for the bot's user-management operations.

The bot creates one Jellyfin user per Discord account and disables that user when the subscription becomes inactive.

## Discord commands

- `/abonnement`
- `/compte`
- `/statut`

## Important limitation

The `/compte` command intentionally does not expose or send a Jellyfin password. A production deployment should use Jellyfin's supported authentication/Quick Connect flow or another secure credential-delivery mechanism rather than putting passwords into Discord messages.
