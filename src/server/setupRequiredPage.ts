import type { SetupIncompleteReason } from './init';

/**
 * The one page an unconfigured instance serves for every non-API path (the
 * request proxy answers it with a 503). It is static content: fixed text, inline
 * CSS, no script, no asset — and no path, version or environment value
 * (security invariant 9; the image's anonymous surfaces carry no version).
 * The Docker command is the documented Docker-only setup, byte for byte: it
 * pulls `latest` because this page may not name a version, and setup records
 * the exact release it ran from, so the stack it writes never runs a moving tag.
 * A literal on purpose — this file never imports the operator scripts.
 */
export const DOCKER_SETUP_COMMAND = [
  'NEURALIS_TAG=latest   # or a release tag: https://hub.docker.com/r/neuralisapp/neuralis/tags',
  'mkdir -p ~/.neuralis ~/neuralis && cd ~/neuralis',
  'docker run -it --rm --user "$(id -u):$(id -g)" \\',
  '  -v /var/run/docker.sock:/var/run/docker.sock --group-add "$(stat -c %g /var/run/docker.sock)" \\',
  '  -v "$HOME/.neuralis:/.neuralis" -e NEURALIS_HOST_HOME="$HOME/.neuralis" \\',
  '  -v "$PWD:$PWD" \\',
  '  neuralisapp/neuralis:"$NEURALIS_TAG" node bin/neuralis.mjs setup --output "$PWD"',
  'docker compose up -d',
].join('\n');

/** The one-line installer the docs site serves: it runs the command below for the visitor. */
export const DOCKER_INSTALLER_COMMAND = 'curl -fsSL https://neuralisapp.com/install.sh | sh';

const FOLDER_SETUP_COMMAND = 'npx neuralis setup';

const HELP_URL = 'https://docs.neuralisapp.com/getting-started/installation#if-something-fails';

const UPDATING_URL = 'https://docs.neuralisapp.com/getting-started/updating';

const REASON_TEXT: Record<Exclude<SetupIncompleteReason, 'secret_moved'>, string> = {
  secret_missing: 'This Neuralis instance has no session secret: setup writes it into the data folder.',
  setup_incomplete: 'This Neuralis instance has no owner account yet, so nobody can sign in.',
};

const PAGE_STYLE = `body{margin:0;background:#0b0d10;color:#e6e8eb;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:46rem;margin:0 auto;padding:3rem 1.25rem}
h1{font-size:1.6rem;margin:0 0 .75rem}
h2{font-size:1.05rem;margin:2rem 0 .5rem}
p{margin:.5rem 0;color:#c4c8ce}
pre{background:#14181d;border:1px solid #262c33;border-radius:6px;padding:.9rem 1rem;overflow-x:auto;color:#9be7c4;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#9be7c4}
a{color:#7cc4ff}`;

/**
 * A home an earlier release set up (owner records, no session secret file): the
 * one way on is the offline `upgrade --apply`, so this page names only that and
 * never the first-install commands.
 */
function renderUpgradeRequiredPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Neuralis needs an upgrade step</title>
<style>
${PAGE_STYLE}
</style>
</head>
<body data-neuralis-state="upgrade-required">
<main>
<h1>Neuralis needs an upgrade step</h1>
<p>This data folder was created by an earlier Neuralis release. Its session secret moves into the data folder once, with the app stopped. Nobody is signed out.</p>
<p>Stop Neuralis, run this in its install folder, then start it again (<code>neuralis update --apply</code> runs it for you):</p>
<pre>neuralis upgrade --apply</pre>
<p>See <a href="${UPDATING_URL}">Updating</a>.</p>
</main>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderSetupRequiredPage(reason: SetupIncompleteReason): string {
  if (reason === 'secret_moved') return renderUpgradeRequiredPage();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Neuralis is not set up yet</title>
<style>
${PAGE_STYLE}
</style>
</head>
<body data-neuralis-state="setup-required">
<main>
<h1>Neuralis is not set up yet</h1>
<p>${escapeHtml(REASON_TEXT[reason])} Until setup has run, every page shows this notice.</p>
<h2>Docker image (Linux or WSL2)</h2>
<p>One command checks Docker, runs setup from the image into a folder of your own and offers to start the stack it writes:</p>
<pre>${escapeHtml(DOCKER_INSTALLER_COMMAND)}</pre>
<p>Or by hand — what the installer runs. The first line picks the release: <code>latest</code>, or a release tag. Setup records the exact release in <code>.env</code>.</p>
<pre>${escapeHtml(DOCKER_SETUP_COMMAND)}</pre>
<p>If you started this container by hand, stop and remove it: the stack runs from the folder setup wrote.</p>
<h2>npm install folder or git clone</h2>
<p>Run this in the install folder, then restart Neuralis:</p>
<pre>${escapeHtml(FOLDER_SETUP_COMMAND)}</pre>
<h2>Still stuck?</h2>
<p>See <a href="${HELP_URL}">If something fails</a> in the installation guide.</p>
</main>
</body>
</html>
`;
}
