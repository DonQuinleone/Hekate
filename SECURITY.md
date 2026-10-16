# Security

Hekate holds unreleased material: mixes, masters and cuts that must not leak before their release. Security reports are welcome and handled first.

## Reporting a vulnerability

Report privately through GitHub: the repository's **Security** tab, **Report a vulnerability**. Please do not open a public issue, pull request or discussion for a suspected vulnerability.

Include what you can:

- what is affected (a route, a page, the image, a dependency) and on which version or commit;
- how to reproduce it, with the smallest steps that show it;
- what an attacker gains: another workspace's data, unreleased media, an account, the server.

Use test data only. Never use material that is not yours, and stop as soon as you see another workspace's data.

## What happens next

- **Within three working days:** an acknowledgement, and whether the report is accepted.
- **Accepted reports:** a fix is worked on privately. The aims are seven days for critical findings (cross-workspace access, unreleased media, account takeover), thirty days for high ones, and the next release for the rest.
- **The fix:** it ships in a release whose notes credit you by a handle you choose, such as your GitHub username, unless you would rather not be credited. Credits never carry a real name or other personal details. An advisory and a CVE follow where they help people running Hekate.

## Supported versions

Hekate is pre-release: until 1.0, fixes land on `master` and in the next release only. From 1.0, the latest release gets fixes, and its notes say how to upgrade.

## How findings are kept at zero

- **Dependencies and the image:** Trivy scans the repository and the app image on every pull request. It fails on any finding with a fix, whatever its severity, and reports unfixed ones to code scanning. An exception goes in `.trivyignore`, with an expiry date and the issue that tracks it.
- **Code:** CodeQL runs the `security-extended` queries over the TypeScript and the workflows, on every pull request and weekly.
- **New dependencies:** dependency review refuses a known vulnerability in an added or updated dependency, and any licence that cannot be combined with AGPL-3.0. pnpm installs nothing published less than a day ago, and runs install scripts only for packages on an allow list.
- **Actions:** every action is pinned to a commit. Dependabot proposes updates weekly.
- **The project as a whole:** OpenSSF Scorecard rates it weekly, and its results are public.

A code-scanning alert is fixed, or dismissed with a written reason when it is a false positive. The zero-findings baseline began on 16 October 2026 (#170).

The design (encryption at rest, protected delivery, watermarking, the access log, authentication) is described in `docs/security.md`.
