# Code signing policy

## Current status

GleamDesk's Windows downloads and Actions packages are **unsigned**. SignPath Foundation has not approved this project, and no signing certificate, signing token or signing service is configured. SHA-256 checksums establish file integrity; they do not establish a trusted publisher.

The local implementation now supports a separate Tauri updater verification key and optional version-bound update signatures. These are not Windows publisher signatures and do not change the unsigned-publisher status above. Local key generation does not mean that GitHub Secrets or signed Release artifacts have been configured; see [updates](UPDATES.md).

## Proposed release process

The following is preparation for an application, subject to Foundation review:

- Build from a reviewed commit in this public repository on a standard GitHub-hosted Windows runner. Keep the dependency lockfiles and record the source commit, workflow run, version and package checksums.
- Build the program and NSIS installer in the same job. Include the project and third-party license notices in the portable package and installer.
- If signing is approved, submit verified workflow artifacts to the signing service. A maintainer must approve each signing request; publishing a Release remains a separate action.
- Sign both the distributed application and installer, then generate checksums for the final signed packages. Do not describe earlier unsigned files as signed.
- Protect signing and repository access with multi-factor authentication. Never put signing credentials in the source tree, application package or logs.

Planned author/reviewer and release approver: [liuyuanlong3232-bit](https://github.com/liuyuanlong3232-bit), the current repository maintainer. Account verification and the acceptability of this single-maintainer arrangement remain to be confirmed. This document does not claim that two-factor authentication or SignPath enrollment has been verified.

## Application readiness

Foundation review is still needed for project reputation, third-party code and assets, the vendored wry dependency, and the scope of the user-requested single-port connectivity tool. There is no automatic eligibility or approval claim.

GleamDesk's [privacy policy](PRIVACY.md) describes local storage and direct network providers. Optional credentials and personal configuration are not included in public builds. See [Windows packages](WINDOWS_PACKAGES.md) for the difference between build checks and native installation/interaction testing.

References: [Foundation conditions](https://signpath.org/terms.html), [GitHub build integration](https://docs.signpath.io/trusted-build-systems/github). Attribution to a signing provider will be added only after approval and successful signing.
