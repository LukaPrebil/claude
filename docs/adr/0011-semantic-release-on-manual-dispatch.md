# ADR 0011: semantic-release on manual dispatch

- **Status**: Accepted
- **Date**: 2026-08-31
- **Deciders**: Luka Prebil Grintal

Use semantic-release, run manually through a `workflow_dispatch` workflow, to produce releases whose version comes from conventional commits. A trigger run computes the semver bump since the last `v*` tag (breaking → major, `feat` → minor, `fix` and other types → patch), pushes one bot release commit carrying `CHANGELOG.md` and the `package.json` version bump, tags `vX.Y.Z`, and creates the GitHub release with notes from the commit range. Merged work accumulates; releases happen only when the operator runs the workflow. The tag doubles as the pin target for installing this repo as a Pi package.

## Context

The repo became installable as a Pi package (ADR 0009), which made versioned tags a first-class artifact: `pi install git:...` pins refs, and a tag is the honest unit of "this set of files, at this version". Releases stay manual - every releasable push becoming a release was rejected as noisy - but hand-typing versions was rejected too, because the conventional-commit discipline already enforced by hooks and skills is exactly the information a version needs.

## Decision

Run the official `semantic-release` Docker image on `workflow_dispatch` (with a dry-run input), configured through `package.json`. The npm plugin updates the version with `npmPublish: false`; the git plugin commits `CHANGELOG.md` plus `package.json` as `chore(release): X.Y.Z [skip ci]`; the GitHub plugin tags and publishes release notes.

This is the first and only bot-authored commit allowed on `main`, amending the all-human property recorded in ADR 0010. The release commit message ends in `[skip ci]` so releases never recurse, and a single run carries the accumulated range since the previous tag.

## Consequences

- Releasing is two clicks (optionally a dry-run first) and its content is fully derived - no version strings, labels, or release-title conventions for humans to maintain.
- `main` gains a non-human commit per release; the fork banner's ahead-count includes it (one per release, plus the bot commit's own tag reference).
- Commit-message discipline becomes load-bearing: a merge whose commits are all `docs:`/`chore:` produces no release; a stray `feat!:` produces a major. The existing conventional-commit gates are the versioning policy.
- Upstream syncs folded into `main` release under this repo's version scheme, so integrations appear in the changelog like any other change.
- The npm registry is never contacted for publishing (`npmPublish: false`); `package.json` is a manifest, not a package.

## Alternatives Considered

- **release-please**: matches semantic analysis but its release unit is a bot PR - merge-to-release is the only mode, with no headless path. Rejected once the operator wanted no release PRs.
- **Hand-rolled `cut-release.sh` + thin workflow**: full control and testable bash, but reimplements commit parsing, semver computation, changelog formatting, tag and release publishing that semantic-release already provides and maintains. Rejected as avoidable own code.
- **Continuous semantic-release on every push to `main`**: zero ceremony, but makes every merge a versioned release and blurs deliberate ships from routine pushes. Rejected for a single-operator repo where the release moment should be a choice.
