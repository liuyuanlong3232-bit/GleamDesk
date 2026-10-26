# Security policy

GleamDesk is an early-stage Windows desktop project. Only the latest source revision is actively maintained. There is no security-response SLA or independently audited security guarantee.

## Reporting a vulnerability

Please avoid publishing working credentials, private account responses, personal files or exploit details in a public issue. Use GitHub's **Report a vulnerability** button if it is available for this repository. Otherwise, open a minimal issue asking for a private reporting channel, without the sensitive details.

Include the affected version, component, expected security boundary and a minimal reproduction using synthetic data. Maintainers will acknowledge and investigate when available.

## Handling credentials

Use the app's credential settings. Never paste secrets into bug reports or commit environment files, databases or user configuration. Connected services retain their own permissions; read-only UI behavior does not make an administrator token read-only.

The optional local Beszel Hub starts only on `127.0.0.1`, reuses an existing database and does not install a service or change system startup. Remote endpoints and local model tools are user-controlled; verify their addresses and permissions yourself.

If a credential is exposed, revoke or rotate it with the issuing service. Removing a file from the current revision does not remove it from Git history.
