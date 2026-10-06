# The host-access plane

Mounting a host folder makes it **visible** to the container. The host plane is a
separate, opt-in capability that lets a command actually **run on the host machine** —
useful when an agent must drive tooling that only exists there.

It is off by default, and it cannot be switched on from inside the application.

## Why the gate is not a setting

Every in-app control is reachable by some in-app role. The real gate has to be something
no role can produce, so it is **operator provisioning on the host**: a service unit, a
secret file, an allowlist, and a compose bind. None of those can be created from within
the platform, whatever permissions a caller holds.

```bash
pnpm neuralis:host-broker init      # secret + scratch + a DENY-ALL ceiling; prints the unit
pnpm neuralis:host-broker install   # the confinement helper, copied from the built image and proved
pnpm neuralis:host-broker upgrade   # install + unit refresh + broker restart (after every rebuild)
pnpm neuralis:host-broker run       # run it in the foreground (or install the unit)
pnpm neuralis:host-broker status    # readiness: secret, ceiling, helper + drift, transport, confinement mode, detached runs, pending requests
pnpm neuralis:host-broker grant --exec|--read|--write <dir>   # answer a recorded request: atomic ceiling write + reload
pnpm neuralis:host-broker attach    # write a host-plane source config for a project
pnpm neuralis:setup --compose-only  # regenerate compose with the broker binds
```

The confinement helper is the sixth artifact. `install` does not compile anything by
hand: it copies the helper the image build already produced and proved, runs that
copy's own self-test through the same check the broker uses, and only then puts it in
place — a copy that cannot prove both its layers is discarded and nothing changes. It
writes to the path the broker's unit names; when that is a root-owned directory it
prints the one `sudo install` line and stops rather than escalating.

The allowlist ships **empty**. That denies every host command until the operator names
the paths the broker may reach: "not configured" never means "unlimited". Only then does
an administrator flip the in-app kill switch and grant the relevant features to roles.

Four independent things must all be true before a host command runs, and naming which
one is missing is the useful diagnosis:

1. the broker is provisioned and running on the host;
2. compose binds its runtime directory into the container;
3. the allowlist covers the path being used;
4. the caller holds the host-plane feature for what they are doing — a shell command and
   a terminal session are separate grants, as are the read and write data planes.

The in-app kill switch is a fifth condition, but only a switch: turning it on grants
nothing that provisioning has not already allowed.

## Confinement has no per-role bypass — it has one operator mode

Host commands are confined by the operating system sandbox and clamped to the
operator-owned ceiling, for every role. There is no privileged tier that escapes it —
unlike container-side execution, where a specific feature does bypass the static path
gate. The read list and the write list are enforced separately, and neither is the
list of paths the broker may *spawn* from; folding those together would publish the
operator's toolchain as readable data.

The one relaxation is the operator's, and it lives in the ceiling file, never in the
application: `"confinement": "unconfined"`. In that mode every host command and host
terminal runs bare as the operator's own account, with that account's login
environment — the agent reaches whatever is installed for the operator (Docker, the
node toolchain, `gh`, `claude`), exactly as a Claude Code session on the same machine
would. That is root-equivalent on the host, as the operator; it is meant for a machine
one person owns and runs, never a shared deployment. It loads only beside
`trustedSingleOperator: true` in the same file (otherwise the broker stays sandboxed and
`status` says why), every result reports `unconfined` so nobody mistakes a computed root
list for an enforced one, and the read/write lists then say only where a shell may start.
Plainly: an unconfined command can read the broker's secret and rewrite the ceiling, so
the request channel below is a courtesy in that mode, not a boundary.

The plane requires a Linux host (or WSL2), because the confinement helper is a Linux
kernel feature and the broker requires it in both modes (declared, never degraded). On
macOS it is unavailable and therefore denied.

## Operating it

- **An image rebuild never reloads the broker, and never refreshes its helper.** It runs
  on the host, not in a container. Send it a reload signal for an allowlist-only change;
  for anything else run `upgrade`, which refreshes the helper and the unit and restarts
  it. `status` prints whether the host helper still matches the running image, and a
  helper the self-test cannot prove is reported unusable — the plane stays dark until
  `upgrade` runs.
- **Restarting it destroys every host terminal session and every background host shell it
  owns.** Prefer the reload signal when sessions matter; `upgrade` refuses to restart while
  a background host shell is still running unless told to force it.
- **The container reaches it through a bind of the broker's runtime *directory*, not the
  socket file.** The broker replaces its socket inode on restart, and a file bind would
  leave the container holding a dead one. A loopback fallback exists where a
  bind-mounted socket cannot be connected to.
- **Removing the bind disables the plane entirely**, regardless of any in-app setting.
- The broker refuses to bind a non-loopback address. That is a hard startup error, not a
  configuration option.

`pnpm neuralis:host-broker status` answers all of the above authenticated, which is why
it is the first thing to run when a host command reports the plane unreachable. A
structured denial names which requirement failed — read it rather than retrying, and
never quietly fall back to running the command in the container instead. `/neuralis`
exists on both sides and means different things.

## Asking for more: the request channel

The ceiling is `effective = requested ∩ ceiling`, and the operator is the only writer.
When a host command — or a host terminal tab — is refused because a path is outside the
ceiling (`ceiling_denied` — the working directory is probed against the ceiling before
anything spawns, so this is the answer a command gets, never a false "does not exist"), the
broker records the request — the paths, the working directory,
which list would need widening, and the `reason` the agent gave the command — in a
file beside the broker's directory (outside what the container can read). `status`
lists the pending requests; the operator answers with
`pnpm neuralis:host-broker grant --exec|--read|--write <dir>`, which appends to the
named list atomically, reloads the broker without a restart, and clears the requests it
satisfied. `exec` is for toolchain roots (a host `node`, `pnpm`, `cargo`, a CLI's
launcher — `init` and `status` suggest the ones detected on the host under
`$suggestedExecRoots`, which the broker never reads), `read`/`write` for the data the
command touches. An agent asks by running the command with a filled-in `reason` and
telling the user what was refused; it never edits the ceiling file.

## Background host shells

`execute background:true` on a host source starts a detached run at the broker, bounded
by the ceiling's `maxDetachedLifetimeMs` (absent or 0 = denied, and the denial says so).
The platform polls it, keeps the authoritative copy of its output, and reports back when
it ends — including after an image rebuild, because the broker survives one and the
platform re-attaches at boot. A broker restart does end every detached run (they die
with the broker, as host terminals do), which is why `upgrade` refuses to restart while
one is running unless forced, and why a rebuild the agent starts from chat must fit under
the lifetime limit.

## For an agent

Treat this page as the explanation you give an operator, not as a checklist to satisfy
yourself. Provisioning is theirs; the deployment is what you are running inside.
