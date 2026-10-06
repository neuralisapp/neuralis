![Neuralis](https://docs.neuralisapp.com/img/neuralis-logo.png)

**Your agents. Your infrastructure. One package protocol.**

Neuralis is a self-hosted, multi-agent and multiplayer AI platform built around one package protocol. It gives organizations a shared place to run agents, work with their knowledge and extend the workspace on infrastructure they control. Models, tools, files and everyday applications meet inside projects with explicit identities and permissions.

An agent has a persistent identity, memory, access to a scoped filesystem and a place on the team's calendar. It can work through chat, scheduled workflows, tools and a virtual desktop. The aim is useful ongoing work with clear responsibility, rather than a succession of disconnected prompts.

![A configured Neuralis workspace with Calendar and Chat open](https://docs.neuralisapp.com/img/getting-started/workspace-1.webp)

*A configured installation with Calendar and Chat beside each other. The workspace, agent choices and installed packages reflect this installation.*

## A workspace for people and agents

Multiplayer means people collaborate with agents in shared projects and conversations. A project holds its members, agents, files, roles and limits. Agents can have different instructions and model choices while working with the knowledge their project makes available.

The workspace brings together Chat, Files, Calendar, Terminal, Admin and Machine applications. Open applications can be arranged in tiled, canvas or grid layouts, minimized to the dock and restored. Packages contribute these applications through App surfaces: widgets, dock entries and chat cards described by the same contract.

Shared projects do not imply simultaneous writes to one conversation or a highly available cluster. Workflows and messaging channels currently run in a single process. The maturity table below records those boundaries so an installation can be planned around what works today.

## Four capability packages, one host

The host supplies sign-in, project membership, roles, limits, the workspace shell and generic package routing. The product capabilities belong to packages:

- **[Agent core](https://docs.neuralisapp.com/docs/agent-core)** runs agents across multiple model providers, with durable conversations, skills, delegation, approvals, workflows, scheduling, messaging channels and the terminal. Agents can use external MCP servers, and authorized external clients can reach their tools through MCP.
- **[Brain core](https://docs.neuralisapp.com/docs/brain-core)** provides the shared URI-addressed filesystem and searchable vector memory. Connectors bring sources into that filesystem, with scope and path policies governing what each caller can read or change.
- **[Admin](https://docs.neuralisapp.com/docs/admin)** provides project and platform administration: members, roles, credentials, configuration, usage, audit and health. Its server-side gates govern every action, including actions initiated outside its interface.
- **[Machine core](https://docs.neuralisapp.com/docs/machine-core)** provides a Linux virtual desktop that people can view and authorized agents can drive through browser and desktop automation. Machines require a Docker engine and have their own grants and isolation boundaries.

These packages share a contract without putting their business logic into the host.

## Extend work through the package protocol

A package declares what it contributes: skills, instructions, rules, agents, workflows, tools, routes, connectors and App surfaces. Contributions have explicit schemas and access requirements. The host discovers and routes them through the package system, so adding a capability does not require a new product-specific branch in the host.

Packages reach an installation in three ways. Administrators can install real packages as host dependencies; these run with first-party trust and must be vetted like other dependencies. Project packages can be dropped into a project's `_packages/` directory, with code confined to the WebAssembly sandbox. Markdown source packages are discovered directly in synced sources, without a separate installation step.

[Agent Skills](https://docs.neuralisapp.com/docs/package-system/skills) and recognized Claude Code, Cursor, Codex, Gemini and Copilot markdown conventions can join the same scoped catalog. This imports supported content, not entire foreign runtimes: hooks and MCP server definitions from those layouts are not loaded. The protocol is designed to connect an ecosystem of capabilities while keeping the installing host responsible for trust.

## Knowledge that stays connected to its source

Brain core treats reachable sources as one governed filesystem. Local folders, shared project data, stored brain content and supported connectors are addressed through URIs. Files remain associated with their source and scope while indexing makes their content searchable to callers who have access.

![The Files application with its source tree and Sources controls](https://docs.neuralisapp.com/img/packages/brain-core-files-1.webp)

*Files and Sources in a configured workspace. Source attachment and path policies determine which content a person or agent can reach.*

The loop works in both directions: sources supply knowledge and markdown capabilities, while packages add connectors that bring further sources into the brain. Credentials remain in the encrypted credential store, rather than becoming workspace files or agent instructions.

## Infrastructure and governance you control

Neuralis is intended for organizations running on their own machines, on-premises infrastructure or private cloud. Model choice includes supported hosted providers and operator-configured endpoints. Provider credentials can resolve at different scopes, while project roles and spending limits govern work under the caller's identity.

Requests from people, agents, scheduled workflows, skill scripts and external MCP clients pass the same deny-by-default boundaries. Identity, project membership, feature grants, package trust and path policies each have a role. Audit records make sensitive actions inspectable.

Today sign-in uses email and password; OIDC and SAML single sign-on are not available. Confined shells depend on a Linux kernel with Landlock support. The optional host access plane requires explicit operator provisioning and should be restricted to a trusted operator's machine. Review the [security model](https://docs.neuralisapp.com/docs/enterprise/security-model) and [deployment guide](https://docs.neuralisapp.com/docs/enterprise/deployment) before choosing a topology.

## Start with a deployment that fits

The intended distribution channels are `npm create neuralis`, the `neuralisapp/neuralis` Docker image and a public host repository. They are not publicly available yet; current installations are built from source. The [installation guide](https://docs.neuralisapp.com/docs/getting-started/installation) describes prerequisites and platform limits. The setup wizard creates installation state, seeds the first owner and project, and preserves existing decisions on a rerun. Native Linux terminal support needs Python, make and a C++ compiler.

Continue with [first run](https://docs.neuralisapp.com/docs/getting-started/first-run), the [workspace guide](https://docs.neuralisapp.com/docs/getting-started/workspace) and [package authoring](https://docs.neuralisapp.com/docs/package-system). Operator procedures live in the shipped operations skill; public source-domain READMEs explain the [workspace package bridge](https://github.com/neuralisapp/neuralis/tree/main/src/workspace/packages), [widget lifecycle](https://github.com/neuralisapp/neuralis/tree/main/src/workspace/widgets), [server package runtime](https://github.com/neuralisapp/neuralis/tree/main/src/server/packages) and [package API](https://github.com/neuralisapp/neuralis/tree/main/src/app/api/packages). Documentation is also available as [agent-readable text](https://docs.neuralisapp.com/llms.txt).

## Maturity

As of 2026-10-05. Scores measure development against documented promises and plans; labels also reflect recorded live use, CI and availability. See the [maturity method](https://docs.neuralisapp.com/docs/getting-started/maturity).

| Subject | Level | Score | Main limitation |
|---|---|---|---|
| Package system | stable | 85 | Source packages are markdown only; code from a synced source runs only when an owner flags that source as a package source, and then in the WebAssembly sandbox. |
| Agent core | beta | 80 | Confined shells need a Linux host kernel with Landlock support; without it, lower-trust shells are refused rather than run unconfined. |
| Brain core | stable | 90 | Git remote operations use HTTPS only; SSH remotes are not supported. |
| Admin | stable | 85 | Admin adds no agent tools or slash commands; agents reach administration through its skills and the routes they wrap. |
| Machine core | stable | 90 | Machines need access to a Docker engine; without one the platform runs with no machines. |
| Host (neuralis) | stable | 90 | Sign-in is email and password; single sign-on (OIDC, SAML) is not available. |
| Install channels | preview | 50 | No install channel is publicly available; installs are built from the source repository. |
| Platform: Linux | experimental | 85 | No run on a standalone Linux host is recorded; the live-tested setup is Docker on WSL2. |
| Platform: Windows with WSL2 | stable | 90 | Use an in-distro Docker engine; with Docker Desktop the host broker needs its loopback TCP fallback. |
| Platform: macOS | experimental | 35 | Neuralis has not been run on macOS so far. |
| Platform: Windows (native) | experimental | 35 | Neuralis has not been run on native Windows so far. |
| Enterprise security and governance | stable | 85 | Give the host access plane only to a single trusted operator's machine. |
| Sign-in | stable | 85 | Single sign-on (OIDC, SAML) is not available; sign-in is email and password. |
| MCP | stable | 85 | Keep the MCP port private unless remote MCP clients are intended. |
| Workflows and scheduling | beta | 75 | Workflows run in a single process; a second replica would run every schedule twice. |
| Messaging channels | preview | 55 | Telegram and WhatsApp are the only messaging platforms. |
| Ecosystem import | stable | 85 | Imported content is markdown only: hooks and MCP server definitions in a foreign layout are not loaded. |
| Marketplace | preview | 70 | The marketplace is not publicly hosted; it runs as a local deployment only. |

## License

Neuralis uses FSL-1.1-ALv2, with each version converting to Apache-2.0 two years after release. The package-system contract layer is Apache-2.0. See [licensing](https://docs.neuralisapp.com/docs/enterprise/licensing) for terms and the distinction between the platform and packages you build against its contract.
