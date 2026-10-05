# ReKindle, self-hosted

[ReKindle](https://github.com/ReKindleOS/ReKindle) by Ukiyo is a web app suite for
Kindle and other e-ink browsers ([rekindle.ink](https://rekindle.ink)). This version runs
it on your own server with Docker: one container replaces Firebase and the Cloudflare
services, and adds e-ink touches such as Page Up / Page Down buttons, a Hacker News app,
working Reddit pictures and Manhuagui in the Manga app.

ReKindle+ apps stay locked for ordinary accounts, as on rekindle.ink without a
subscription (the admin account has them, and a server owner can unlock them for everyone
with `PLUS_FOR_ALL=true`). Chat and online multiplayer are not included.

**Setup, settings and the full list of changes:** [`selfhost/README.md`](../selfhost/README.md)

Licensed like the original under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) (`LICENSE.md`):
non-commercial use only, give credit, share changes under the same license. If you enjoy
ReKindle, support its creator at [rekindle.ink](https://rekindle.ink).
