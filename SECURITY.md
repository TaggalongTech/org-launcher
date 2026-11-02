# Security

## Report a problem

Please report security problems privately, through a GitHub Security Advisory:
[Report a vulnerability](https://github.com/TaggalongTech/org-launcher/security/advisories/new).

Don't open a public issue for a security problem. Say what you found, how to reproduce it, and which version and platform you used. We'll answer as soon as we can and keep you posted while we fix it.

## What we care about most

Org Launcher runs a local server with access to every org your sf CLI is logged in to. These matter most:

- A login token or login link written to disk, logged, sent to the page or shown in an error.
- Another web page, or another computer, reaching the local server.
- Any network call that isn't to one of your own orgs.

## Supported versions

Fixes go into the latest release.
