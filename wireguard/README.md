# WireGuard

Place the VPS WireGuard server configuration at:

`wireguard/wg_confs/wg0.conf`

Example topology:

- VPS: `10.50.0.1`
- Home server: `10.50.0.2`

The VPS peer should normally have:

`AllowedIPs = 10.50.0.2/32`

The home peer should normally have:

`AllowedIPs = 10.50.0.1/32`

If Jellyfin runs on the home server itself and listens on `0.0.0.0:8096`, the bot can use:

`http://10.50.0.2:8096`

Keep the WireGuard private key out of Git. The `wireguard/` directory is intended to be deployed with its secret config created directly on the VPS.
