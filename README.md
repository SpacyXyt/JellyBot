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

## Diagnosing Jellyfin connection failures

For `EHOSTUNREACH 10.8.0.2:8096`, run these checks on the deployed VPS:

```sh
docker compose exec wireguard wg show
docker compose exec wireguard ip route get 10.8.0.2
docker compose exec bot node -e 'fetch(process.env.JELLYFIN_URL + "/System/Info/Public", {signal: AbortSignal.timeout(5000)}).then(r => { console.log("Jellyfin HTTP status:", r.status); process.exitCode = r.ok ? 0 : 1; }).catch(e => { console.error(e.cause || e.message); process.exitCode = 1; })'
```

Check the peer handshake, its AllowedIPs, the route to the home server, and whether Jellyfin listens on the VPN interface on port 8096. Check the home firewall as well. Both `JELLYFIN_URL` and `JELLYFIN_PROXY_TARGET` must point to an address reachable from the bot's WireGuard network namespace. A code update cannot restore an unavailable VPN peer.

If Jellyfin returns HTTP 500 after connectivity is restored, inspect its server logs at the matching timestamp. Account creation is coalesced per Discord user within one bot process; after a failed creation, the bot checks whether the account exists before propagating the error. Other server failures still need investigation. After fixing the cause, resend failed events from Stripe's webhook dashboard.

The `util._extend` warning originates in the installed `http-proxy` dependency. It is separate from the Discord acknowledgement and Jellyfin connection failures; this patch does not suppress it.
