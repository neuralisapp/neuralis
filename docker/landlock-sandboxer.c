// nrs-landlock-sandboxer — the OS-enforcement wrapper for the host/container
// execution planes.
//
// A tiny, dependency-free, musl-static helper that turns on a Landlock LSM
// filesystem sandbox (plus, optionally, a seccomp AF_UNIX denial and a mount
// mask) and then execve()s the real command inside it.
//
// WHO RUNS THROUGH IT. In the CONTAINER this is the wall builder for
// lower-trust agents; `exec.unconfined` holders bypass it (bare spawn) —
// that bypass is deliberate and owner-decided. On the HOST PLANE there is NO
// bypass for anyone, owner included: every host exec and every host PTY is
// spawned through this helper, and if the helper is missing the broker answers
// 503 rather than spawning bare.
//
// WHAT LANDLOCK DOES *NOT* COVER — read this before trusting the sandbox.
// Landlock is a FILESYSTEM LSM. It governs open()/rename()/etc. It does NOT
// govern connect() on a pathname AF_UNIX socket. Measured on the shipped helper
// with /run granted NOWHERE and the path built from character codes:
//     open("/run/docker.sock")    -> DENIED (EACCES)
//     connect("/run/docker.sock") -> ALLOWED, HTTP/1.0 200 OK
//     read("/etc/shadow")         -> DENIED (control: the sandbox was live)
// Docker is the least important member of that class: the systemd USER BUS
// (/run/user/<uid>/bus) is reachable the same way, and a StartTransientUnit on
// it spawns an unconfined process as the operator on every Linux host.
//
// ABI matrix, so nobody re-derives it: ABI 4 = LANDLOCK_ACCESS_NET_* is TCP
// bind/connect ONLY; ABI 6 covers ABSTRACT sockets only; the pathname-unix
// right (LANDLOCK_ACCESS_FS_RESOLVE_UNIX, the unix_find hook) lands in ABI 9 /
// kernel ~7.1. At v7.0 security/landlock/fs.c has no unix hook at all, and no
// deployable LTS (6.8 / 6.12 / 6.18 = ABI 7) has it. The in-kernel fix exists
// and is unreachable, which is why --deny-unix-sockets (seccomp) exists below.
// When ABI 9 IS deployable this becomes a one-constant change: define
// LANDLOCK_ACCESS_FS_RESOLVE_UNIX and add it to the handled set + an add_path
// branch. Do NOT raise TARGET_ABI to 9 before then — it would exclude every
// current LTS and ship a plane nobody can run.
//
// Contract (argv):
//   sandboxer --selftest
//       Proves BOTH enforcement layers, each in the way it can actually be
//       proven: the seccomp filter is installed in a FORKED CHILD (a filter is
//       irreversible, so an in-process check would poison the rest of the run)
//       and asserted allow/deny row by row; the Landlock ruleset is then
//       applied here and proven deny-outside / allow-inside.
//       Exit 0 = Landlock usable at target ABI AND the seccomp filter enforces.
//   sandboxer [--ro PATH]... [--rw PATH]... [--ro-opt PATH]... [--rw-opt PATH]...
//             [--mask PATH]... [--deny-unix-sockets] -- CMD [ARG...]
//       read+exec on each --ro PATH, read+write on each --rw PATH, PLUS the
//       fixed system baseline (below), then execve(CMD, ARG...). A missing
//       --ro/--rw PATH is fatal (EXIT_SETUP). The -opt forms are the
//       path-precise cover of a policy-mixed source: a missing entry is
//       skipped, and the final component is opened O_NOFOLLOW — a symlink entry
//       is skipped, never granted through (an O_PATH open FOLLOWS a link, and
//       the rule would land on its target). At most MAX_ROOTS_PER_CLASS
//       read-class and as many write-class roots.
//
// Exit codes (distinct, so the caller can tell WHY it failed):
//   EXIT_ABI_UNSUPPORTED (91) — Landlock absent or ABI < target (fail-closed).
//   EXIT_USAGE           (92) — bad argv.
//   EXIT_SETUP           (93) — a Landlock/seccomp syscall failed unexpectedly.
//   EXIT_EXEC            (94) — execve failed (command not found, etc).
//   EXIT_SECCOMP         (95) — --selftest only: the seccomp filter could not
//                               be installed, or it did not enforce (a denial
//                               row passed, or an allow row was refused). The
//                               image build FAILS on this; 91 stays tolerated.
//   (a successful run never returns — it becomes the command via execve.)
//
// The system baseline (C3 of the validated plan) is applied HERE, not by the
// caller: without a read+exec baseline the sandboxed bash cannot even read its
// own binary, the dynamic linker, coreutils, or /etc — the ruleset is
// deny-everything-not-listed.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

// The minimum Landlock ABI we require. ABI 3 (Linux 6.2+) gives us
// LANDLOCK_ACCESS_FS_TRUNCATE, which closes the `truncate()`/`O_TRUNC` write
// vector. Below this we fail closed for untrusted (the caller denies the shell).
#define TARGET_ABI 3

#define EXIT_ABI_UNSUPPORTED 91
#define EXIT_USAGE 92
#define EXIT_SETUP 93
#define EXIT_EXEC 94
#define EXIT_SECCOMP 95

// Defensive definitions so an older <linux/landlock.h> in the build image still
// compiles (the running kernel, not the header, governs availability).
#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

// Read-ish (also grants directory listing + execute) — used for RO roots and
// the whole system baseline.
#define ACCESS_FS_READ                                                         \
  (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE |                  \
   LANDLOCK_ACCESS_FS_READ_DIR)

// Write-ish — the full mutation set up to ABI 3 (REFER + TRUNCATE included).
#define ACCESS_FS_WRITE                                                        \
  (LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |             \
   LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR |            \
   LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |               \
   LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |             \
   LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM |             \
   LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE)

// Directory-only bits. A regular file cannot be granted these (the kernel
// returns EINVAL), so we mask them off when a rule targets a non-directory.
#define ACCESS_FS_DIR_ONLY                                                     \
  (LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR |              \
   LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR |           \
   LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |              \
   LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |            \
   LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM |            \
   LANDLOCK_ACCESS_FS_REFER)

#define ACCESS_FS_ALL (ACCESS_FS_READ | ACCESS_FS_WRITE)

// Per-call root classes. BEST_EFFORT = the system baseline (a missing path is
// skipped); REQUIRED = --ro/--rw (a missing path is fatal); OPTIONAL =
// --ro-opt/--rw-opt (missing skipped, symlink never followed).
#define ROOT_BEST_EFFORT 0
#define ROOT_REQUIRED 1
#define ROOT_OPTIONAL 2

// Ceiling per class (read-class = --ro + --ro-opt, write-class = --rw +
// --rw-opt), on the heap. The caller's own ceiling on derived roots is 4096;
// the headroom covers the required roots and the read-only extras beside it.
#define MAX_ROOTS_PER_CLASS 8192

struct root_arg {
  const char *path;
  int mode;
};

static inline int ll_create_ruleset(const struct landlock_ruleset_attr *attr,
                                    size_t size, __u32 flags) {
  return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}
static inline int ll_add_rule(int ruleset_fd, enum landlock_rule_type type,
                              const void *attr, __u32 flags) {
  return (int)syscall(__NR_landlock_add_rule, ruleset_fd, type, attr, flags);
}
static inline int ll_restrict_self(int ruleset_fd, __u32 flags) {
  return (int)syscall(__NR_landlock_restrict_self, ruleset_fd, flags);
}

// The fixed system read+exec baseline (C3). Missing paths are skipped silently
// (not every image has every dir); a path that exists but fails to add is fatal.
static const char *const BASELINE_RO[] = {
    "/bin",      "/sbin",         "/usr",     "/lib",  "/lib64",
    "/usr/lib",  "/usr/local",    "/etc",     "/opt",  "/proc/self",
    "/sys/kernel/mm/transparent_hugepage", "/tmp",    NULL,
};

// Dev nodes agents legitimately read/write; kept in sync with DEV_ALLOWANCES
// in shellUriPolicyGate.ts. NOTE: /dev/stdin|stdout|stderr are deliberately
// ABSENT — they are /proc/self/fd/N symlinks (a pipe under Docker), so a
// Landlock path_beneath rule on them fails EBADFD. They need no rule anyway:
// the child inherits fds 0/1/2 already open, and Landlock gates open(), never
// writes to already-open descriptors.
static const char *const BASELINE_RW[] = {
    "/dev/null", "/dev/zero",    "/dev/full",   "/dev/random",
    "/dev/urandom", "/dev/tty",  NULL,
};

// Resolver configuration a confined process needs in order to have DNS AT ALL.
//
// `/etc` is already in the baseline, but Landlock evaluates the RESOLVED path,
// and on most modern systems `/etc/resolv.conf` is a symlink pointing OUT of
// `/etc`: systemd-resolved uses `/run/systemd/resolve/`, WSL2 uses
// `/mnt/wsl/`. So a confined shell reads `/etc/resolv.conf`, follows the link,
// and is denied — losing name resolution while raw sockets still work.
//
// The failure mode is what makes this worth a dedicated rule: nothing says
// "permission denied". `getaddrinfo` simply cannot find a nameserver, so tools
// report a network timeout. The live case was the `claude` CLI on WSL2
// answering "Failed to connect to api.anthropic.com: ETIMEOUT … Claude Code
// might not be available in your country" — a sandbox path denial wearing a
// geopolitics costume, on a host whose network was fine (a raw TCP connect to
// 1.1.1.1:443 succeeded from the same confined shell).
//
// These are read-only rules over resolver CONFIG FILES, not their parent
// directories. In particular, `/mnt/wsl` also contains Docker Desktop state;
// granting the directory just to reach `/mnt/wsl/resolv.conf` would be a broad
// and unrelated read grant. `add_path` skips a missing path silently, so
// listing the common target files is safe on every distro. The runtime
// `realpath` additionally covers a layout none of the literals anticipate.
static const char *const BASELINE_RESOLVER_RO[] = {
    "/run/systemd/resolve/resolv.conf",
    "/run/systemd/resolve/stub-resolv.conf",
    "/run/resolvconf/resolv.conf",
    "/run/NetworkManager/resolv.conf",
    "/mnt/wsl/resolv.conf",
    NULL,
};

// Add one path rule to the ruleset. `access` is masked to the ruleset's handled
// set and to file-vs-dir. A non-existent path is skipped (returns 0) unless
// `mode` is ROOT_REQUIRED; a ROOT_OPTIONAL symlink is skipped, never followed.
// Returns 0 on success/skip, -1 on a real failure.
static int add_path(int ruleset_fd, const char *path, uint64_t access,
                    uint64_t handled, int mode) {
  int fd = open(path, O_PATH | O_CLOEXEC | (mode == ROOT_OPTIONAL ? O_NOFOLLOW : 0));
  if (fd < 0) {
    if (mode != ROOT_REQUIRED &&
        (errno == ENOENT || errno == EACCES ||
         (mode == ROOT_OPTIONAL && errno == ENOTDIR)))
      return 0; // best-effort baseline entry / vanished optional root
    fprintf(stderr, "sandboxer: open(%s): %s\n", path, strerror(errno));
    return -1;
  }
  struct stat st;
  uint64_t allowed = access & handled;
  int have_stat = fstat(fd, &st) == 0;
  if (mode == ROOT_OPTIONAL && (!have_stat || S_ISLNK(st.st_mode))) {
    close(fd); // the link itself — granting it would mean nothing safe
    return 0;
  }
  if (have_stat && !S_ISDIR(st.st_mode))
    allowed &= ~ACCESS_FS_DIR_ONLY; // a file cannot carry dir-only rights
  struct landlock_path_beneath_attr pb = {
      .allowed_access = allowed,
      .parent_fd = fd,
  };
  int rc = ll_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &pb, 0);
  int saved = errno;
  close(fd);
  if (rc != 0) {
    fprintf(stderr, "sandboxer: add_rule(%s): %s\n", path, strerror(saved));
    return -1;
  }
  return 0;
}

// Probe the running kernel's Landlock ABI via the syscall (NOT securityfs — C6:
// on WSL2 securityfs was empty while the syscall returned 3). Returns the ABI
// integer, or -1 if Landlock is unavailable.
static int probe_abi(void) {
  int abi = ll_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  return abi;
}

// ---------------------------------------------------------------------------
// Layer 3 — seccomp AF_UNIX denial.
//
// This is what actually closes the gap the file header describes. It works
// because socket(2)'s DOMAIN is a plain scalar in arg0: seccomp cannot
// dereference a pointer, so filtering connect(2) by socket PATH is impossible,
// but refusing to hand out an AF_UNIX socket at all is trivially expressible
// and closes ABSTRACT sockets in the same stroke (nothing else does).
//
// socketpair(2) is deliberately NOT filtered: it returns an already-connected
// pair that can never be pointed at somebody else's socket, and Node's
// child_process.fork() IPC needs it.
//
// io_uring is denied because it is a MEASURED bypass — its submission queue
// performs connect() without ever issuing the syscall the filter watches, so a
// socket-only filter reports green while staying wide open.
//
// THE ALTERNATE-ABI HOLE, and why the range check below is not optional.
// A cBPF filter sees `nr` as a plain integer, and on x86_64 the SAME kernel
// entry point accepts x32 syscall numbers — the ordinary number with bit 30
// set (`__X32_SYSCALL_BIT`, 0x40000000). Measured on the shipped helper before
// this guard: `socket(AF_UNIX)` -> EACCES, but `syscall(0x40000029, AF_UNIX,
// SOCK_STREAM, 0)` -> fd 3, connect("/var/run/docker.sock") -> CONNECTED; and
// `io_uring_setup(425)` -> EACCES while `syscall(0x400001a9, ...)` -> a working
// ring, which performs connect() without ever issuing a filtered syscall. Every
// per-syscall arm below was therefore reachable around. The guard is a RANGE
// rejection (`nr >= NRS_ALT_ABI_MIN`), not four x32 twins: twins would cost one
// more arm for every syscall ever added and would still leave RET_ALLOW
// reachable at any un-enumerated x32 number.
//
// It is placed IMMEDIATELY AFTER the `nr` load, which is the load-bearing
// detail: a cBPF jt/jf is an offset from the NEXT instruction, so inserting at
// index k shifts only jumps j with j < k <= target(j). Here k = 4, every jump
// below has j >= 4, and the one jump above it (instruction 1) targets index 3 —
// above the insertion. Every literal below stays byte-identical. "Helpfully"
// renumbering them is the silently-catastrophic error.
//
// The verdict is EACCES, not KILL_PROCESS (owner decision, 2026-08-18): the
// same filter now rides the CONTAINER plane and an interactive terminal tab, and
// a silent SIGSYS kill of a member's tab is a capability degradation. Security
// value is identical — the syscall never reaches the kernel either way.
//
// KNOWN, ACCEPTED BREAKAGE (document it, do not "fix" it by relaxing): syslog
// (/dev/log), ssh-agent (SSH_AUTH_SOCK), X11 and D-Bus clients. DNS survives
// only while nsswitch resolves `hosts:` through files/dns — a `resolve` or
// `nscd` entry routes lookups over AF_UNIX and would break name resolution.
// ---------------------------------------------------------------------------

#if defined(__x86_64__)
#define NRS_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NRS_AUDIT_ARCH AUDIT_ARCH_AARCH64
#endif

#ifndef SECCOMP_RET_KILL_PROCESS
#define SECCOMP_RET_KILL_PROCESS 0x80000000U
#endif
#ifndef SECCOMP_RET_ERRNO
#define SECCOMP_RET_ERRNO 0x00050000U
#endif
#ifndef SECCOMP_RET_ALLOW
#define SECCOMP_RET_ALLOW 0x7fff0000U
#endif
#ifndef SECCOMP_RET_DATA
#define SECCOMP_RET_DATA 0x0000ffffU
#endif
#ifndef SECCOMP_SET_MODE_FILTER
#define SECCOMP_SET_MODE_FILTER 1
#endif
#ifndef __NR_io_uring_setup
#define __NR_io_uring_setup 425
#endif
#ifndef __NR_io_uring_enter
#define __NR_io_uring_enter 426
#endif
#ifndef __NR_io_uring_register
#define __NR_io_uring_register 427
#endif

// The lower bound of every ALTERNATE syscall numbering this filter refuses.
// x86_64: the x32 bit (__X32_SYSCALL_BIT). EVERY arch: a defensive upper bound
// on `nr` — no real syscall number comes close, so the arm is inert on arm64
// (one syscall table, all numbers < 600; its AArch32 compat tasks report a
// different arch token and are already killed at instruction 1). An inert guard
// that cannot misfire beats a conditional that can be forgotten, so it is
// UNCONDITIONAL — do not wrap it in an #ifdef.
#define NRS_ALT_ABI_MIN 0x40000000U

// Returns 0 on success, -1 on failure. FAILS CLOSED: an unknown architecture or
// a rejected filter is an error, never a silent pass-through — the caller turns
// that into EXIT_SETUP.
static int apply_seccomp(void) {
#ifndef NRS_AUDIT_ARCH
  fprintf(stderr,
          "sandboxer: seccomp: unsupported architecture — refusing to run "
          "unfiltered\n");
  return -1;
#else
  struct sock_filter filter[] = {
      /*  0 */ BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                        offsetof(struct seccomp_data, arch)),
      /*  1 */ BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NRS_AUDIT_ARCH, 1, 0),
      /*  2 */ BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
      /*  3 */ BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                        offsetof(struct seccomp_data, nr)),
      // Alternate-ABI guard. JGE, not JSET: JSET tests bit 30 only, JGE tests
      // `nr >= 2^30`, catching a bit-31/negative `nr` at identical cost (cBPF
      // compares are unsigned). jt=0/jf=1 ⇒ fall through to the deny on a hit,
      // skip it otherwise. NOTHING below this line changes.
      /*  4 */ BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, NRS_ALT_ABI_MIN, 0, 1),
      /*  5 */ BPF_STMT(BPF_RET | BPF_K,
                        SECCOMP_RET_ERRNO | (EACCES & SECCOMP_RET_DATA)),
      /*  6 */ BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 7, 0),
      /*  7 */ BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_enter, 6, 0),
      /*  8 */ BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_register, 5, 0),
      /*  9 */ BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 1, 0),
      /* 10 */ BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
      /* 11 */ BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                        offsetof(struct seccomp_data, args[0])),
      /* 12 */ BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0),
      /* 13 */ BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
      /* 14 */ BPF_STMT(BPF_RET | BPF_K,
                        SECCOMP_RET_ERRNO | (EACCES & SECCOMP_RET_DATA)),
  };
  struct sock_fprog prog = {
      .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
      .filter = filter,
  };
  // PR_SET_NO_NEW_PRIVS is already set by apply_sandbox() — seccomp's
  // precondition. Do not reorder those two.
  if (syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog) == 0)
    return 0;
  if (errno == ENOSYS &&
      prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog, 0, 0) == 0)
    return 0;
  fprintf(stderr, "sandboxer: seccomp filter rejected: %s\n", strerror(errno));
  return -1;
#endif
}

// ---------------------------------------------------------------------------
// Layer 5 — per-spawn path masking. Ranked LAST and deliberately FAIL-SOFT.
//
// It is DEAD on stock Ubuntu 24.04+: the shipped unprivileged_userns AppArmor
// profile allows creating the namespace but denies capabilities inside it, so
// the mount fails for want of CAP_SYS_ADMIN. It is measured working on WSL2,
// which is exactly why it must not be the floor — a positive result there does
// not generalise. On a system unit the same effect is available natively via
// TemporaryFileSystem=/run + BindPaths=, which is where it belongs.
// ---------------------------------------------------------------------------
static void write_map(const char *path, const char *content) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0)
    return;
  ssize_t ignored = write(fd, content, strlen(content));
  (void)ignored;
  close(fd);
}

// Never returns non-zero: masking is best-effort by design.
static void apply_mounts(const char *const *masks, int mask_count) {
  if (mask_count <= 0)
    return;
  uid_t uid = getuid();
  gid_t gid = getgid();
  if (unshare(CLONE_NEWUSER | CLONE_NEWNS) != 0) {
    fprintf(stderr, "sandboxer: mask: unshare unavailable (%s) — relying on "
                    "seccomp + the service account\n",
            strerror(errno));
    return;
  }
  char buf[64];
  snprintf(buf, sizeof(buf), "0 %u 1", (unsigned)uid);
  write_map("/proc/self/uid_map", buf);
  write_map("/proc/self/setgroups", "deny");
  snprintf(buf, sizeof(buf), "0 %u 1", (unsigned)gid);
  write_map("/proc/self/gid_map", buf);

  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) {
    fprintf(stderr, "sandboxer: mask: cannot privatise mounts (%s) — skipping\n",
            strerror(errno));
    return;
  }
  for (int i = 0; i < mask_count; i++) {
    struct stat st;
    if (stat(masks[i], &st) != 0)
      continue; // nothing there to hide
    int rc;
    if (S_ISDIR(st.st_mode)) {
      rc = mount("tmpfs", masks[i], "tmpfs",
                 MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, "size=0k");
    } else {
      // A socket or regular file cannot carry a tmpfs; shadow it with an inert
      // node so connect() fails ENOTSOCK instead of reaching the daemon.
      rc = mount("/dev/null", masks[i], NULL, MS_BIND, NULL);
    }
    if (rc != 0)
      fprintf(stderr, "sandboxer: mask(%s): %s\n", masks[i], strerror(errno));
  }
}

// Build the ruleset with the baseline + the given RO/RW roots, then
// landlock_restrict_self. Returns 0 on success, -1 on setup failure.
static int apply_sandbox(const struct root_arg *ro_roots, int ro_count,
                         const struct root_arg *rw_roots, int rw_count) {
  uint64_t handled = ACCESS_FS_ALL;
  struct landlock_ruleset_attr attr = {.handled_access_fs = handled};
  int ruleset_fd = ll_create_ruleset(&attr, sizeof(attr), 0);
  if (ruleset_fd < 0) {
    fprintf(stderr, "sandboxer: create_ruleset: %s\n", strerror(errno));
    return -1;
  }

  // System baseline first (C3).
  for (int i = 0; BASELINE_RO[i]; i++)
    if (add_path(ruleset_fd, BASELINE_RO[i], ACCESS_FS_READ, handled, ROOT_BEST_EFFORT) != 0)
      goto fail;
  for (int i = 0; BASELINE_RW[i]; i++)
    if (add_path(ruleset_fd, BASELINE_RW[i], ACCESS_FS_ALL, handled, ROOT_BEST_EFFORT) != 0)
      goto fail;
  for (int i = 0; BASELINE_RESOLVER_RO[i]; i++)
    if (add_path(ruleset_fd, BASELINE_RESOLVER_RO[i], ACCESS_FS_READ, handled, ROOT_BEST_EFFORT) != 0)
      goto fail;
  // Follow the live link too, for a layout the literals above do not cover.
  // Grant ONLY the target file; its containing directory may hold unrelated
  // host state.
  {
    char resolved[PATH_MAX];
    if (realpath("/etc/resolv.conf", resolved) != NULL) {
      if (add_path(ruleset_fd, resolved, ACCESS_FS_READ, handled, ROOT_BEST_EFFORT) != 0)
        goto fail;
    }
  }

  // Per-call policy roots.
  for (int i = 0; i < ro_count; i++)
    if (add_path(ruleset_fd, ro_roots[i].path, ACCESS_FS_READ, handled,
                 ro_roots[i].mode) != 0)
      goto fail;
  for (int i = 0; i < rw_count; i++)
    if (add_path(ruleset_fd, rw_roots[i].path, ACCESS_FS_ALL, handled,
                 rw_roots[i].mode) != 0)
      goto fail;

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "sandboxer: no_new_privs: %s\n", strerror(errno));
    goto fail;
  }
  if (ll_restrict_self(ruleset_fd, 0) != 0) {
    fprintf(stderr, "sandboxer: restrict_self: %s\n", strerror(errno));
    goto fail;
  }
  close(ruleset_fd);
  return 0;

fail:
  close(ruleset_fd);
  return -1;
}

// ---------------------------------------------------------------------------
// --selftest, half 1 — the SECCOMP filter.
//
// Why this exists: `apply_seccomp` is reachable only from main() behind
// `--deny-unix-sockets`, so for its whole life the filter was proven by NOBODY.
// Three gates all passed with the x32 hole wide open — the Dockerfile build
// stage, `landlockProbe.ts` (container boot) and `sandboxProbe.mjs` (broker
// readiness) — because each only asked "does the helper exit 0?".
//
// A seccomp filter is IRREVERSIBLE for the installing thread, so the check runs
// in a FORKED CHILD: an in-process assert would confine the rest of --selftest
// (and, under a kill-verdict design, would be a guaranteed self-kill that fails
// 100 % of image builds). The parent only reads the child's exit status.
//
// The rows are matched: two denials AND three capability allows. An over-broad
// filter is the real boot-fatal risk here — it would deny every confined shell —
// and rows 3-5 are what catch it.
// ---------------------------------------------------------------------------
#define SELFTEST_CHILD_OK 0
#define SELFTEST_CHILD_INSTALL_FAILED 10
#define SELFTEST_CHILD_UNIX_ALLOWED 11
#define SELFTEST_CHILD_UNIX_WRONG_ERRNO 12
#define SELFTEST_CHILD_ALT_ABI_ALLOWED 13
#define SELFTEST_CHILD_ALT_ABI_WRONG_ERRNO 14
#define SELFTEST_CHILD_INET_DENIED 15
#define SELFTEST_CHILD_SOCKETPAIR_DENIED 16

// Runs INSIDE the forked child. Never returns.
static void seccomp_selftest_child(void) {
  // apply_seccomp's precondition. In the normal spawn path apply_sandbox() sets
  // it; here the seccomp half must stand on its own so a Landlock-less build
  // host still gates on a broken filter.
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0)
    _exit(SELFTEST_CHILD_INSTALL_FAILED);
  if (apply_seccomp() != 0)
    _exit(SELFTEST_CHILD_INSTALL_FAILED);

  // 1. Native AF_UNIX socket — must be refused by the filter.
  int fd = (int)syscall(__NR_socket, AF_UNIX, SOCK_STREAM, 0);
  if (fd >= 0)
    _exit(SELFTEST_CHILD_UNIX_ALLOWED);
  if (errno != EACCES)
    _exit(SELFTEST_CHILD_UNIX_WRONG_ERRNO);

  // 2. The SAME call at an alternate-ABI syscall number (x86_64: x32). The
  //    filter runs BEFORE kernel dispatch, so a kernel without x32 support
  //    cannot make this row vacuous: an un-guarded number would surface as
  //    ENOSYS, a guarded one as EACCES. We assert EACCES specifically.
  fd = (int)syscall((long)(NRS_ALT_ABI_MIN | (unsigned)__NR_socket), AF_INET,
                    SOCK_STREAM, 0);
  if (fd >= 0)
    _exit(SELFTEST_CHILD_ALT_ABI_ALLOWED);
  if (errno != EACCES)
    _exit(SELFTEST_CHILD_ALT_ABI_WRONG_ERRNO);

  // 3. AF_INET must still work — the filter is a UNIX-domain denial, not a
  //    network kill switch.
  fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0)
    _exit(SELFTEST_CHILD_INET_DENIED);
  close(fd);

  // 4. socketpair() must still work — Node's child_process.fork() IPC needs it,
  //    and it is deliberately unfiltered (an already-connected pair can never be
  //    pointed at somebody else's socket).
  int sv[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0)
    _exit(SELFTEST_CHILD_SOCKETPAIR_DENIED);
  close(sv[0]);
  close(sv[1]);

  _exit(SELFTEST_CHILD_OK);
}

static const char *seccomp_child_reason(int code) {
  switch (code) {
  case SELFTEST_CHILD_INSTALL_FAILED:
    return "the filter could not be installed";
  case SELFTEST_CHILD_UNIX_ALLOWED:
    return "native socket(AF_UNIX) was ALLOWED";
  case SELFTEST_CHILD_UNIX_WRONG_ERRNO:
    return "native socket(AF_UNIX) failed with the wrong errno (want EACCES)";
  case SELFTEST_CHILD_ALT_ABI_ALLOWED:
    return "an alternate-ABI (x32) socket() was ALLOWED — the filter is bypassable";
  case SELFTEST_CHILD_ALT_ABI_WRONG_ERRNO:
    return "the alternate-ABI socket() failed with the wrong errno (want EACCES)";
  case SELFTEST_CHILD_INET_DENIED:
    return "socket(AF_INET) was DENIED — the filter is over-broad";
  case SELFTEST_CHILD_SOCKETPAIR_DENIED:
    return "socketpair() was DENIED — the filter is over-broad";
  default:
    return "unknown child verdict";
  }
}

// Returns 0 when the filter enforces exactly as designed, EXIT_SECCOMP otherwise.
static int run_seccomp_selftest(void) {
  pid_t pid = fork();
  if (pid < 0) {
    fprintf(stderr, "selftest: seccomp: fork: %s\n", strerror(errno));
    return EXIT_SECCOMP;
  }
  if (pid == 0)
    seccomp_selftest_child();

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno == EINTR)
      continue;
    fprintf(stderr, "selftest: seccomp: waitpid: %s\n", strerror(errno));
    return EXIT_SECCOMP;
  }
  if (WIFSIGNALED(status)) {
    // Under the EACCES verdict nothing in the child should ever be killed.
    fprintf(stderr, "selftest: FAIL seccomp probe killed by signal %d\n",
            WTERMSIG(status));
    return EXIT_SECCOMP;
  }
  if (!WIFEXITED(status)) {
    fprintf(stderr, "selftest: FAIL seccomp probe did not exit normally\n");
    return EXIT_SECCOMP;
  }
  int code = WEXITSTATUS(status);
  if (code != SELFTEST_CHILD_OK) {
    fprintf(stderr, "selftest: FAIL seccomp: %s (child exit %d)\n",
            seccomp_child_reason(code), code);
    return EXIT_SECCOMP;
  }
  fprintf(stderr, "selftest: PASS seccomp (AF_UNIX denied, alt-ABI denied, "
                  "AF_INET + socketpair allowed)\n");
  return 0;
}

// --selftest: prove the seccomp filter enforces (forked child, above), then
// confine to a fresh writable temp subdir and prove a write outside it is
// denied (EACCES) and a write inside it is allowed.
static int run_selftest(void) {
  // Seccomp FIRST and unconditionally: it does not depend on Landlock, and a
  // build host without Landlock exits 91 below — which the Dockerfile tolerates
  // — so gating the filter behind that check would give the image build no
  // seccomp coverage at all.
  int seccomp_rc = run_seccomp_selftest();
  if (seccomp_rc != 0)
    return seccomp_rc;

  int abi = probe_abi();
  if (abi < 0) {
    fprintf(stderr, "selftest: Landlock unavailable: %s\n", strerror(errno));
    return EXIT_ABI_UNSUPPORTED;
  }
  if (abi < TARGET_ABI) {
    fprintf(stderr, "selftest: Landlock ABI %d < target %d\n", abi, TARGET_ABI);
    return EXIT_ABI_UNSUPPORTED;
  }
  fprintf(stderr, "selftest: Landlock ABI %d (>= %d) OK\n", abi, TARGET_ABI);

  char tmpl[] = "/tmp/nrs-selftest-XXXXXX";
  char *dir = mkdtemp(tmpl);
  if (!dir) {
    fprintf(stderr, "selftest: mkdtemp: %s\n", strerror(errno));
    return EXIT_SETUP;
  }
  const struct root_arg rw[] = {{dir, ROOT_REQUIRED}};
  if (apply_sandbox(NULL, 0, rw, 1) != 0)
    return EXIT_SETUP;

  // Inside the writable root → must succeed.
  char inside[256];
  snprintf(inside, sizeof(inside), "%s/ok", dir);
  int fi = open(inside, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fi < 0) {
    fprintf(stderr, "selftest: FAIL write inside sandbox denied: %s\n",
            strerror(errno));
    return EXIT_SETUP;
  }
  close(fi);

  // Outside (a system dir that is RO baseline) → must be denied.
  int fo = open("/etc/nrs-selftest-should-fail", O_WRONLY | O_CREAT, 0600);
  if (fo >= 0) {
    fprintf(stderr, "selftest: FAIL write outside sandbox was ALLOWED\n");
    close(fo);
    return EXIT_SETUP;
  }
  if (errno != EACCES) {
    fprintf(stderr, "selftest: FAIL outside write errno=%s (want EACCES)\n",
            strerror(errno));
    return EXIT_SETUP;
  }
  fprintf(stderr, "selftest: PASS (inside allowed, outside denied EACCES)\n");
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--selftest") == 0)
    return run_selftest();

  // Parse: [--ro P]... [--rw P]... [--ro-opt P]... [--rw-opt P]...
  //        [--mask P]... [--deny-unix-sockets] -- CMD [ARG...]
  struct root_arg *ro = calloc(MAX_ROOTS_PER_CLASS, sizeof(*ro));
  struct root_arg *rw = calloc(MAX_ROOTS_PER_CLASS, sizeof(*rw));
  if (!ro || !rw) {
    fprintf(stderr, "sandboxer: out of memory\n");
    return EXIT_SETUP;
  }
  const char *mask[64];
  int ro_count = 0, rw_count = 0, mask_count = 0;
  int deny_unix = 0;
  int i = 1;
  for (; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) {
      i++;
      break;
    }
    int is_ro = strcmp(argv[i], "--ro") == 0;
    int is_ro_opt = strcmp(argv[i], "--ro-opt") == 0;
    int is_rw = strcmp(argv[i], "--rw") == 0;
    int is_rw_opt = strcmp(argv[i], "--rw-opt") == 0;
    if ((is_ro || is_ro_opt) && i + 1 < argc) {
      if (ro_count >= MAX_ROOTS_PER_CLASS) {
        fprintf(stderr, "sandboxer: too many read-only roots\n");
        return EXIT_USAGE;
      }
      ro[ro_count].path = argv[++i];
      ro[ro_count++].mode = is_ro_opt ? ROOT_OPTIONAL : ROOT_REQUIRED;
    } else if ((is_rw || is_rw_opt) && i + 1 < argc) {
      if (rw_count >= MAX_ROOTS_PER_CLASS) {
        fprintf(stderr, "sandboxer: too many writable roots\n");
        return EXIT_USAGE;
      }
      rw[rw_count].path = argv[++i];
      rw[rw_count++].mode = is_rw_opt ? ROOT_OPTIONAL : ROOT_REQUIRED;
    } else if (strcmp(argv[i], "--mask") == 0 && i + 1 < argc) {
      if (mask_count >= 64) {
        fprintf(stderr, "sandboxer: too many --mask paths\n");
        return EXIT_USAGE;
      }
      mask[mask_count++] = argv[++i];
    } else if (strcmp(argv[i], "--deny-unix-sockets") == 0) {
      deny_unix = 1;
    } else {
      fprintf(stderr, "sandboxer: unexpected arg: %s\n", argv[i]);
      return EXIT_USAGE;
    }
  }
  if (i >= argc) {
    fprintf(stderr, "sandboxer: no command after --\n");
    return EXIT_USAGE;
  }
  char **cmd = &argv[i];

  int abi = probe_abi();
  if (abi < 0 || abi < TARGET_ABI) {
    fprintf(stderr, "sandboxer: Landlock ABI %d < target %d — refusing\n", abi,
            TARGET_ABI);
    return EXIT_ABI_UNSUPPORTED;
  }

  // ORDER IS LOAD-BEARING, and each step constrains the next:
  //   1. apply_mounts   — needs the mount syscalls the seccomp filter does not
  //                       block anyway, but must precede Landlock so the new
  //                       namespace is the one being confined.
  //   2. apply_sandbox  — Landlock, and it sets PR_SET_NO_NEW_PRIVS, which is
  //                       seccomp's precondition.
  //   3. apply_seccomp  — last, so it cannot refuse the setup's own syscalls.
  apply_mounts(mask, mask_count);
  if (apply_sandbox(ro, ro_count, rw, rw_count) != 0)
    return EXIT_SETUP;
  if (deny_unix && apply_seccomp() != 0)
    return EXIT_SETUP;

  execvp(cmd[0], cmd);
  fprintf(stderr, "sandboxer: execvp(%s): %s\n", cmd[0], strerror(errno));
  return EXIT_EXEC;
}
