# Security policy

Neuralis is self-hosted software that runs agents with real permissions over your files,
your credentials and, when you provision it, your host. We treat a vulnerability report as
the most important message we receive.

## Supported versions

Neuralis is in beta (`0.x`). Security fixes land in the newest published release only:
the host image `neuralisapp/neuralis`, the `npm create neuralis` scaffolder and the
`@neuralis/*` packages it installs. Before reporting, check whether the issue still
reproduces on the newest release.

| Version | Supported |
|---|---|
| newest `0.x` release | yes |
| any earlier release | no — update first |

## Reporting a vulnerability

**Email `security@neuralisapp.com`.** Do not open a public issue, pull request or
discussion for a suspected vulnerability.

Please include:

- the version you run (the image tag in your `.env` `NEURALIS_IMAGE_TAG`, or the host
  `package.json` version) and how it was installed;
- what an attacker can do, and which identity they start from — an anonymous visitor, a
  project member, an agent, a package author, an external MCP client;
- the steps to reproduce it, as small as you can make them;
- whether you believe it is already being exploited.

Never send real credentials, API keys or other people's data — a redacted example is enough.

## What happens next

- We acknowledge your report **within 5 working days**.
- We confirm or rule out the issue, and tell you which.
- We keep you informed while a fix is prepared, and agree with you on when the issue is
  disclosed. We do not promise a fixed date for the fix itself: it depends on the issue,
  and we would rather tell you the truth than a deadline.
- With your permission, we credit you in the release notes of the fix.

## Scope

In scope: the host (this folder — authentication, projects, the package routing boundary,
the MCP service), the `@neuralis/*` packages, the published Docker image, and the
`npm create neuralis` scaffolder.

Out of scope: third-party packages, MCP servers and model providers you connect yourself
(report those to their authors), and a deployment whose operator has deliberately widened
a default — for example a host-access ceiling set to `unconfined`.
