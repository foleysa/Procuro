# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly:

- **Email:** security@procuro.dev
- **Response time:** We acknowledge reports within 48 hours and provide an initial assessment within 5 business days.
- **Do not** open a public GitHub issue for security vulnerabilities.

## CI Security Scanners

Three automated scanners run on every push and pull request to `main`:

### Gitleaks — Secret Scanning

Scans the full Git history for accidentally committed secrets, API keys, tokens, and credentials. Configuration is in `.gitleaks.toml` at the repo root, which extends the default ruleset and includes allowlists for test/fixture files.

**If your PR is blocked:** Remove the secret from the commit (use `git filter-branch` or BFG Repo-Cleaner to purge from history), rotate the leaked credential immediately, and re-push.

### Semgrep — Static Analysis (SAST)

Runs static analysis using OWASP Top 10, TypeScript, React, and secrets rulesets at ERROR severity. Only new findings (compared to the base branch) block PRs.

**If your PR is blocked:** Review the Semgrep rule linked in the CI output. Fix the flagged code pattern — common issues include insecure HTTP requests, missing encryption parameters, and injection risks.

### pnpm audit — Dependency Vulnerabilities

Audits all dependencies for known vulnerabilities at `high` and `critical` severity levels.

**If your PR is blocked:** Run `pnpm audit` locally to identify the vulnerable package. Update to a patched version with `pnpm update <package>`, or if no patch exists, evaluate the risk and document a temporary exception.

## Dependabot

Dependabot is configured to open weekly pull requests for:

- **npm** dependency updates (grouped by production and dev dependencies)
- **GitHub Actions** version updates

Review and merge these PRs promptly to stay current on security patches.

## Pre-Existing Findings

Known findings that predate the CI scanner rollout are documented in [`.security-baseline.md`](.security-baseline.md). These do not block PRs and are tracked with individual follow-up tasks.

## Remediation Timelines

| Severity | Target Resolution |
|----------|-------------------|
| Critical | 24 hours |
| High | 7 days |
| Medium | 30 days |
| Low | Next quarter |

## Scope

These scanners cover source code, Git history, and dependency trees. The following are out of scope for this CI pipeline:

- Container image scanning
- Infrastructure-as-Code scanning
- Runtime monitoring and intrusion detection
- Penetration testing
- Compliance certifications
