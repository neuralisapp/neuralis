# The host-access plane — paired devices

Mounting a host folder makes it **visible** to the container. The device plane is a
separate, opt-in capability that lets a command actually **run on a machine** — the server
itself, or a person's own laptop — useful when an agent must drive tooling that only
exists there.

It is off until a person turns a machine into a **device**, and that cannot be done from
inside the application.

## Why the gate is not a setting

Every in-app control is reachable by some in-app role. The real gate has to be something
no role can produce, so it is **an act on the machine itself**: running the device client
there, pairing it with one sign-in, and naming in its ceiling the folders it may reach.
None of that can be created from within the platform, whatever permissions a caller holds.
The machine's broker dials OUT to the app (`/ws/device-link` on the MCP port); the app holds
only a hash of the device's secret — the secret itself lives on the device, never in the
container and never in platform config.

```bash
npm install -g @neuralis/cli    # on the machine, as the user whose files the app should reach (Node.js 22.22+)
neuralis device pair            # one sign-in in the browser; this machine becomes your device
neuralis device install         # the login service, the confinement helper, a ceiling with no folder
neuralis device grant DIR       # let the app read DIR (--write to change it; --host URL with several hosts)
neuralis device status          # pairing, ceiling, helper, link, readiness, pending requests
neuralis device run             # the broker in the foreground, instead of the service
```

`install --unconfined` is the single-person mode (below). A macOS or Windows machine installs
sandboxed once its OS sandbox prints all four probe rows (Seatbelt; on Windows 11 ≥ 26100.9278
Microsoft Execution Containers — implemented, not yet proven on that hardware), and with
`--unconfined` — your explicit act, which the install names — where it does not. An image-only server needs the npm CLI too: the installer's script refuses `device`. **The server is a device too.** After the upgrade that brought devices,
`neuralis device install` on the server adopts the broker it already had — its secret, its
ceiling, its background runs — without pairing again (the offline upgrade registered it and
wrote `~/.neuralis/device/device.json`; `device install`, or `device run`, moves it into
`device/hosts/<hostKey>/` and writes the local socket's own secret `device/local-secret`).

The allowlist ships with **no folder**. That denies every host folder until the device's owner
names the paths it may reach: "not configured" never means "unlimited". Its `exec` list starts
with only the folders of the Node and the CLI `dist` the device runs (read and run, printed by
`install`). Only then does an administrator's kill switch matter, and the roles that may use it.

**No grant reaches the device's own credentials** — the device folder (`~/.neuralis/device`:
every host's link secret, the local secret, the ceiling), the CLI sign-in folder (`cliHome()`,
`NEURALIS_CLI_HOME` / `XDG_CONFIG_HOME` included — `device install` writes either into the
service when set), and the helper and service file where this account can write them. A host's
file requests answer them like a path outside the ceiling, and a command or terminal run for
another member never reaches them, even under `grant ~ --others exec` (on Linux such a folder is
handed to that command split around them: `ls ~` itself is refused there, everything below
works). The owner's own sandboxed commands and terminal never reach the device folder either
(the same split on Linux); the sign-in folder and the service file stay reachable to them.
**Nor does a grant reach the host's own data** in the same home — `app/` (keys, users, sessions,
platform config, logs), `projects/` (every project's conversations and packages), `checkpoints/`,
`qdrant-backups/`, `build/` and `qdrant-version.json`: file requests answer all of them like a path
outside the ceiling, for every caller, and a command or terminal run for another member never
reaches them. The owner's own commands and terminal never reach `app/` and the backups either,
with two exceptions: `projects/` stays theirs (a native host runs its owner's unconfined shell in
the project's own folder, as a container does), and an installed package under
`app/packages/node_modules` that the host names for the owner's command is read and run there,
never written. `device grant` refuses a folder inside any of them; `device-scratch/`,
`device-requests/`, `device-shells/` and `launch/` stay reachable. The admin pages, the app's own sources (`data://`, `packages://`, `app://`) and
`pnpm neuralis:*` still reach them. Each device protects its OWN resolved home (`NEURALIS_HOME` if
set for the device, else `~/.neuralis` / `%USERPROFILE%\.neuralis` / `$XDG_DATA_HOME/neuralis`) —
residual: a host home moved by an env the device does not share (a Docker host's
`NEURALIS_HOST_HOME`, an XDG split) is not covered. The
Node and the CLI `dist` the device runs, and the helper, are read-only to every sandboxed command
and every host file write, so `grant ~ --write` (or `C:\ --write`) cannot replace the CLI that
writes the ceiling (measured on Windows 11 too: under `C:\ --write` a write into the CLI is
refused, a sibling write works and the bundled Node runs). On Windows a whole-drive grant covers the
drive's existing entries and new top-level folders; an entry created directly under the drive root
after a command started is not covered (a new top-level file is refused by Windows itself). `device
status` and the local `/readyz` list all three sets; `ceiling_covers_protected_path` names a folder
opened to others that covers one. Residuals: a hardlink to one of those files already inside a
granted folder, a bind mount, a sign-in folder moved after `install`, the rest of the desktop
app's own folder (writable under a covering grant), and `unconfined` (the child can read the
secret and rewrite all of it).

Four independent things must all be true before a host command runs, and naming which
one is missing is the useful diagnosis:

1. the device is paired and its broker is running and linked (`device status`);
2. its ceiling covers the path being used;
3. the source names that device, and the caller may use it — its owner with `device.own`, or
   anyone else with the device-plane feature (`exec.device` for a shell, `terminal.device` for a
   terminal tab) and only while the device's live verdict is `sandboxed`;
4. the source's path rules allow the operation (read, write and exec are separate grants).
   `exec` decides where a command may START — the working directory, judged as a folder, so a
   rule on `X/**` covers `X` itself. It does not decide what runs: a command started in an
   allowed folder can still run a script from another folder it can read (`sh ../noexec/run.sh`).
   To seal a folder, deny `read` there too. The sandbox reproduces the read and write rules
   inside the folder, not just at its root.

The in-app kill switch (`hostBrokerEnabled`) is a fifth condition, but only a switch: turning
it on grants nothing the device has not already allowed.

## Confinement has no per-role bypass — it has one owner mode

On Linux, host commands are confined by the operating system sandbox (the filesystem) and
clamped to the device owner's ceiling, for every role. There is no privileged tier that
escapes it — unlike container-side execution, where a specific feature does bypass the static
path gate. The read list and the write list are enforced separately, and neither is the list
of paths the broker may *spawn* from; folding those together would publish the owner's
toolchain as readable data. A sandboxed ceiling whose helper is missing or cannot prove itself
is not ready (declared, never degraded).

The one relaxation is the owner's, and it lives in the ceiling file, never in the
application: `"confinement": "unconfined"`. In that mode every host command and host
terminal runs bare as the device's own account, with that account's login environment —
the agent reaches whatever is installed there (Docker, the node toolchain, `gh`, `claude`),
exactly as a Claude Code session on the same machine would. That is root-equivalent on the
machine, as that user; it is meant for a machine one person owns and runs, never a shared
deployment. It loads only beside `trustedSingleOperator: true` in the same file (otherwise the
broker stays sandboxed and `status` says why), every result reports `unconfined` so nobody
mistakes a computed root list for an enforced one, and the read/write lists then say only where
a shell may start. Plainly: an unconfined command can read the device secret and rewrite the
ceiling, so the request channel below is a courtesy in that mode, not a boundary. Such a device
serves its OWNER only — nobody else's commands run on an unconfined machine.

Linux ships the confinement helper inside the device client, checked against its manifest;
macOS uses the OS's own Seatbelt and Windows x64 the bundled Microsoft Execution Containers
binary — each proven per machine by the four-row probe. Where one does not prove itself, the
device is unconfined only by its owner's explicit `--unconfined`, never inferred from the
platform, and therefore owner-only.

## Operating it

- **An image rebuild never reloads a device, and never refreshes its helper.** The broker
  runs on the machine, not in a container. A ceiling edit needs nothing — the broker re-reads
  the file on its next request; a new client release is `neuralis update --cli --apply`: the client moves itself, then
  runs `neuralis device install`, which refreshes the helper and the service and restarts it —
  only when a newer client was published; on a current client run `neuralis device install` itself. On
  the server, the end of `neuralis rebuild` prints whether the device's helper still matches
  the new image. A change to the helper itself (its source is `neuralis/docker/landlock-sandboxer.c`)
  reaches each device the same way — the image rebuild for the server's copy, the CLI release
  that ships the rebuilt helper, then `neuralis device install` on every device. Until then a
  device keeps the old one: a helper from before the identity map runs a sandboxed spawn as
  `root` inside its user namespace, so a commit made there is authored `root`; after it the
  author is the account's own git identity (the repository's `user.name`/`user.email`, else the
  account name — git refuses an account with an empty full name, as on this server).
- **Restarting it destroys every terminal tab and every background shell it owns.**
  `install` refuses to restart while a background run is still in flight.
- **Offline is a state, not an error.** When a device's link is down its sources show offline,
  their indexed text stays readable, and their settings can still be changed; the terminal and
  shell refuse by name until the device dials again.
- Revoking a device, or disabling its owner, closes its link; a reset of the owner's sessions
  makes it pair again.

`neuralis device status` answers all of the above on the machine itself, which is why it is
the first thing to run when a host command reports the device unreachable. A structured denial
names which requirement failed — read it rather than retrying, and never quietly fall back to
running the command in the container instead. The plane is the source's STORED transport — one
`host` kind, and a folder whose config names a `device` runs on that device, one without on the
app's own side (`sourcePlane`) — never the look of a path or a kind name: behind Docker
`/neuralis` exists on both sides and means different things; on the desktop app both sides are
one machine, and the plane is still picked by the source.

## Asking for more: the request channel

The ceiling is `effective = requested ∩ ceiling`, and the device's owner is the only writer
(the owner's own commands may also read the installed Neuralis packages on this computer, never
write them).
When a host command — or a host terminal tab — is refused because a path is outside the
ceiling (`ceiling_denied` — the working directory is probed against the ceiling before
anything spawns, so this is the answer a command gets, never a false "does not exist"), the
broker records the request — the paths, the working directory, which list would need
widening, and the `reason` the agent gave the command — in a file beside the device's
directory (outside anything the app can read). `status` lists the pending requests; the owner
answers with `neuralis device grant <dir> [--write] [--host <url>]` (or `--exec` for a toolchain root), which adds to the named list
atomically, takes effect on the next request without a restart, and clears the requests it
satisfied. `--exec` is for toolchain roots (a host `node`, `pnpm`, `cargo`, a CLI's launcher —
`install` and `status` suggest the ones detected on the machine under `$suggestedExecRoots`,
which the broker never reads; the first ceiling already holds the folders of the CLI's own Node and
`dist`, so a skill script and `neuralis request` run without a grant), `read` (the default) and `--write` for the data the command
touches. An agent asks by running the command with a filled-in `reason` and telling the user
what was refused; it never edits the ceiling file.

## Background host shells

`execute background:true` on a folder on a device starts a detached run on that device, bounded by
the ceiling's `maxDetachedLifetimeMs` (absent or 0 = denied, and the denial says so). The
platform polls it over the link, keeps the authoritative copy of its output, and reports back
when it ends — including after an image rebuild, because the device survives one and the
platform re-attaches at boot. A broker restart does end every detached run, which is why
`install` refuses to restart while one is running, and why a rebuild the agent starts from chat
must fit under the lifetime limit.

## For an agent

Treat this page as the explanation you give a person, not as a checklist to satisfy
yourself. Pairing and the ceiling are theirs, on their machine; the deployment is what you are
running inside.
