# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use GitHub's private reporting: open the repository's **Security** tab and click **Report a vulnerability**
([direct link](https://github.com/nandkishormewara/pdf-studio/security/advisories/new)).

Include what you found, how to reproduce it, which part is affected (web app, React viewer, iOS SDK,
Android SDK or server) and the version or commit. A small sample PDF helps, but leave out any personal or
confidential data.

You can expect a first reply within a week. Once a fix is released, the report is published as a security
advisory, with credit to you unless you'd rather stay anonymous.

## Supported versions

Security fixes go into the latest release.

## Scope

Of most interest:

- PDFs, XFDF or JSON that make a viewer or the server run code, read files it shouldn't, or crash or hang.
- Redaction that leaves the removed content recoverable.
- Digital signatures that verify when they shouldn't.
- Ways for the server to be misused, for example file access or request forgery through its endpoints.

The server is meant to run on infrastructure you control. Put it behind your own authentication and TLS:
it doesn't provide user accounts itself.
