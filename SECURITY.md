# Security Policy

## Supported versions

This project is a pre-1.0 proof of concept. Security fixes are applied to the
`main` branch only.

| Version | Supported |
|---|---|
| `main` | ✅ |
| older  | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report privately through one of:

- GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  ("Report a vulnerability" under the **Security** tab), or
- email **ipedrazas@gmail.com** with the details.

Please include:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- any affected configuration or versions.

We will acknowledge your report as soon as we can, keep you updated on progress,
and credit you in the release notes unless you prefer to remain anonymous.

## Scope notes

This PoC handles several secrets via environment variables — the Anthropic API
key, the Telegram bot token, and DataboxPPM authentication. Keep these out of
version control (`.env` is git-ignored). Production auth and security hardening
are explicit non-goals at this stage (see
[`plans/implementation-plan.md`](plans/implementation-plan.md) §11); please flag
anything that would block a hardening pass later.
