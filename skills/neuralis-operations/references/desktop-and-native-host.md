# The desktop app's host, a native clone, and reaching it from outside

## The desktop app's host — `neuralis up` / `down` / `status`

```bash
neuralis up                 # start Qdrant, the app and the sandbox origin; returns once ready (log: app/logs/host.log in the data home)
neuralis up --foreground    # the same, supervised in this terminal: one JSON line per state on stdout
neuralis status [--json]    # stopped | starting | ready | restarting | failed, its origins, Qdrant
neuralis down               # stop it (the running host first drains its turns), wait ≤ 30 s
```

These run the desktop app's own host — the image's tree, run on the machine with no container
— and only that one (`up` refuses anywhere else; a Docker install is `docker compose up -d`);
there `up`, `down` and `status` run precompiled, with no TypeScript runner resident. The
data home is `NEURALIS_HOME`, unchanged from Docker: the same `~/.neuralis` tree, its projects
and records; the desktop app's `.env` is `<NEURALIS_HOME>/app/config/.env`, which its first start
writes (`setup --native --yes`, asking nothing in the terminal). Everything listens on
`NEURALIS_BIND_HOST` — `127.0.0.1` — and Qdrant on loopback too. `up` ends before starting anything with
11 when another host holds the home (and prints a `locked` line naming it), 12 when the stored data
needs `neuralis upgrade --apply`, 13 when the home has no owner yet, 15 when a Docker install set the
home up (no desktop `.env` yet), 10 when a port is taken; 14 when a child keeps dying. A home a release
before the session-secret file set up has no `app/config/session-secret.key`: `up` exits 1 and the
adopt refuses — run `neuralis upgrade --apply` in its Docker install first (app stopped).

```bash
neuralis setup --native --yes --owner-email EMAIL [--project NAME] [--qdrant docker|binary] [--desktop|--no-desktop] [--ollama MODE]   # a new home; the password on stdin
neuralis setup --native --yes [--qdrant binary [--copy-vectors]]   # adopt a home a Docker install set up
neuralis setup --native --yes --refresh-qdrant                    # its Qdrant lines again (a changed key or port)
```

**Where the vectors live** (`QDRANT_MODE`). A new home keeps them in Docker when Docker answers:
setup writes a Qdrant-only `docker-compose.yml` beside the `.env` (its own project and named volume per
home, a loopback port) and `up` starts it and stops it again when it stops (`compose stop`, never
`down`; a host restart stops nothing, and a Docker install's Qdrant is never stopped); else the bundle's binary in `<home>/qdrant-storage`. An
adopted Docker home uses that install's Qdrant (`external`: its loopback URL, key and folder, read
from the install the home records — the one thing the adopt reads outside the home), and `up` starts
only its vector store there, never the Docker app. `--qdrant binary` gives the app its own store,
`--copy-vectors` copies the Docker vectors into it (cold and counted, the Docker app stopped, the same
Qdrant version), `--refresh-qdrant` follows a changed key or port; a refused key starts the host with
in-memory vectors and the `ready` line says so. `--no-desktop` leaves the virtual desktop off (on with
Docker by default; `setup-and-compose.md` §What `neuralis setup` writes). The mode table, its refusals and the copy:
§Adopting a Docker home, below.

Users and passwords, credentials, the OAuth signing keys and the session secret are the home's, so
they are the Docker install's; a browser session or an MCP client's sign-in stays bound to the
address it was issued on (the desktop's `http://127.0.0.1:<port>` is not Docker's
`http://localhost:3100`).

**One host per data home.** The first one holds `<home>/app/host.lock`; a second one — the
Docker stack and the desktop app on the same `~/.neuralis` — refuses to start and names the
holder: stop it first (`neuralis down`, or `docker compose stop neuralis` in the install folder —
its Qdrant keeps serving; the desktop app offers this stop, asking twice). A lock whose desktop host
is gone is taken over by the next `up`, or cleared by `neuralis down` — unless another program still
holds the lock file open (Windows): then `up` refuses (exit 11) and `down` refuses (exit 1), each saying so; run it again once that program has let go of it. A Docker holder refreshes its
lock every 10 s; one not refreshed for 30 s is taken over by the next CONTAINER on that home, and the
refusal names the lock file and how long ago it was refreshed. A Docker holder is never taken over
from the desktop side, nor the reverse — then stop it cleanly once, or delete `<home>/app/host.lock`
by hand. The app
stops with `up` itself, even a killed one; a binary Qdrant does not, so `down` stops what a killed `up`
left answering (by the process ids the lock records) before it clears the lock, and keeps the lock
while one still answers. The app updates itself (the Windows build and the AppImage install a newer release before the host
starts; the deb and the macOS preview show it; `update` refuses here), and `mount` does
not apply: a folder of this machine reaches the app through your own paired device (the host-access
plane, `host-plane.md`). `backup` and `qdrant-upgrade` handle the app's own Qdrant in Docker like a Docker
install's (quit the app for the upgrade); the Qdrant binary the app ships moves only with the app's
update — `qdrant-upgrade` refuses binary mode there.

## Adopting a Docker home

The desktop app runs the image's own host tree on the machine instead (`neuralis up`, above): loopback only, so publishing it further means a reverse proxy, declared in
`NEURALIS_TRUSTED_PROXIES` (`setup-and-compose.md` §Boot environment). Its `.env` lives in `<NEURALIS_HOME>/app/config`, and so does,
in docker mode, its Qdrant-only `docker-compose.yml`: the same `qdrant` service the full stack emits
(digest-pinned image of the recorded version, named `qdrant-data` volume — never a bind mount — a
loopback port, `QDRANT_API_KEY` interpolated from the `.env` beside it), under a compose project of
its own per data home (`NEURALIS_COMPOSE_PROJECT`, `neuralis-desktop-<hash of the home path>`), so two
homes never share a volume; `backup` and `qdrant-upgrade` run it from that folder, without `-f`.

On a home a Docker install set up, `up` exits 15 and `setup --native --yes` (no owner flags) adopts
it: the desktop host's own `.env` and the install record, nothing else in the home. Its vectors come
from the install the home records beside it (`app/config/installs.json`, exactly one non-desktop row
whose folder still is that install) — the ONE thing the adopt reads outside the home: that folder's
`.env`. By its `QDRANT_MODE`:

| Docker install | The desktop `.env` |
|---|---|
| `docker` | `external`: `http://127.0.0.1:<NEURALIS_QDRANT_PORT>`, its `QDRANT_API_KEY`, `NEURALIS_QDRANT_COMPOSE_DIR=<its folder>` — `up` runs `docker compose -p <project> up -d --no-deps <vectorstore>` there when it is down and waits for `/healthz`; it never starts the app's service and never stops the Qdrant |
| `external` | `external`: its `QDRANT_URL` and key, no folder |
| `skip` | `skip`: vectors in memory |
| `binary` | refused: its store is `<home>/qdrant-storage`, the files the desktop's own binary would open |
| none recorded, several, a stale row, no `.env`, a docker mode without a key, an unknown mode | refused by name |

`--qdrant binary` gives the desktop host its own binary, key and `qdrant-storage/` instead, on a
port other than the one the recorded Docker install publishes its Qdrant on (taken even while that
Qdrant is stopped); with `--copy-vectors` the Docker volume is copied into it first
(`qdrant-upgrade/transfer.mts`): refused unless the recorded version (`qdrant-version.json`) and the
live Docker Qdrant equal the bundle's, the home's store is empty, twice the volume's size is free and
the Docker app is stopped; then the exact point count of every collection is read from the Docker
Qdrant (a stopped one is started and waited for), it stops, the volume is cold-tarred read-only and
unpacked as the running user (`--no-same-owner`), Docker's Qdrant is started again on every path,
and the bundle's binary on the copy must answer the same counts — a different count or a check that
fails moves the copy aside as `qdrant-storage.failed-<time>` and names it. `--estimate-copy` prints the
volume's size and the free space as one JSON line and writes nothing. `--refresh-qdrant` (a home
already adopted) rewrites only the Qdrant lines from the recorded install again — a rotated key or a
moved port; until then the host runs with in-memory vectors (`vector.qdrant.unauthorized` in its log,
`vectorsReason: unauthorized` on `up`'s `ready` line). A recorded `qdrant-version.json` is left as it
is: it describes the Docker volume's store, and a binary copy shares it — a Docker `qdrant-upgrade`
does not move the copy.

## A source clone run natively — `neuralis start`

```bash
npm run build && neuralis start   # the app on the port .env names (NEURALIS_APP_PORT; 3100 when unset)
```

`npm run start` binds 3100 whatever `.env` says; `start` runs the same server on the port setup
wrote. It runs in a clone only — the desktop app's host is `up`, a Docker install `docker compose up -d`.

## Reach it from outside — `neuralis tunnel`, the LAN switch, local models

```bash
neuralis tunnel                                  # status: the hostnames, on or off
neuralis tunnel on DOMAIN [--access EMAIL|@DOMAIN]   # app./mcp./sandbox.DOMAIN → this host (a Cloudflare named tunnel)
neuralis tunnel off                              # the origins `on` replaced (a proxy/LAN one), else this machine's (tunnel + DNS stay)
neuralis setup … --tunnel DOMAIN [--access …]    # either setup branch: the same `tunnel on`, once .env is written
neuralis setup --native --yes --lan on|off       # the desktop app's host on every address of this network, or loopback
neuralis setup --native --yes --ollama existing|docker|binary|none   # its local models (also a first-run choice)
```

`tunnel on` needs a Cloudflare account and the domain in it: it signs in once in the browser,
creates or reuses the tunnel `neuralis-<home>`, routes the three hostnames, writes the connector's
`config.yml` into `<home>/app/cloudflared` (0700 — the certificate and credentials live there, never
in `.env`) and the three origins into the operator `.env` (never a platform setting). A quick tunnel
is not offered: it carries no live updates. The desktop app's host fetches the pinned `cloudflared`
and `up` runs it after the host is ready; a Docker install gets a `cloudflared` compose service
(`setup --compose-only` runs for you; then `docker compose up -d`). `--access` puts Cloudflare Access
in front of the app's browser hostname only, `/api/` bypassed — MCP clients, the CLI and devices
cannot pass an Access login and keep Neuralis's own; it asks for an API token once and stores none.
So the tunnel keeps MCP on its own name: `neuralis tunnel` warns when `MCP_BASE_URL` is the app
address, and `tunnel on DOMAIN` writes it back.
**Every origin change retires the sign-ins made on the old one:** MCP clients and the CLI sign in
again, paired devices pair again, invite links issued before point at the old address (Admin →
Users says so for a link on a local address), and a provider-side app (a static MCP client id, a git
OAuth App, a channel app) is re-registered with the new `<APP_URL>/api/oauth/…` callback. A tunnel is reachability, never identity: every
request still meets the app's login and deny-by-default.

The LAN switch moves the app, the MCP server and the sandbox origin to every address and writes
this computer's network address as the origin; Qdrant and Ollama stay on loopback (they have no
login). The two are independent; both default off. Ollama is optional (default `none`); choosing it
seeds the local embedding model, and `up` fetches what is missing in the background — the host never
waits for it. Mechanism and the `.env` keys: `references/setup-and-compose.md` §Boot environment.
