# ADR 0010: Fork lineage with a personal main and an upstream mirror

- **Status**: Accepted
- **Date**: 2026-08-31
- **Deciders**: Luka Prebil Grintal

## Context

This repo started as a Claude-only config (`domengabrovsek/claude`) that the owner contributed to through fork PRs, and grew the multi-harness direction (ADR 0008, shared setup across Claude Code, Codex, and Pi) that upstream is keeping in an open PR. The config needed a home the owner controls: live resources (extensions, settings) for personal machines plus the shared multi-host layout. Upstream integration in both directions is a requirement, not a nice-to-have: upstream keeps evolving, and shared improvements must keep flowing back without path churn.

## Decision

Stay a GitHub fork of `domengabrovsek/claude` and make the fork's default branch the live personal multi-harness config. A mirror branch, `upstream-main`, tracks `domengabrovsek/claude@main` and is the only base for upstream-bound PR branches. Upstream work integrates by merging `upstream/main` into `main` (GitHub's Sync fork button does the same).

## Consequences

- Machine bootstrap is clone-and-apply (the default branch is the config); no checkout dance.
- Diverged `main` means the GitHub Contribute button is gone by design; PRs to upstream are opened from branches cut off `upstream-main`, never off `main`, or personal commits ship in the PR.
- Upstream merges flow in as plain merges; the claude-specific files keep their inherited root locations so those merges stay conflict-free.
- Upstream-side work keeps using the `domengabrovsek/claude` local clone, so upstream PRs keep their clean, un-relocated paths and no cherry-pick path rewriting is needed.
- Content licensing follows upstream until a LICENSE appears; the fork ancestry is the carrying mechanism.

## Alternatives Considered

- **Independent repo with `upstream` remote**: cleanest ownership, but loses one-step upstream integration and makes every shared update a manual re-vendor. Rejected once the fork's integration value was named as a goal.
- **Keep contributing everything upstream** (wait for PR #125): the multi-harness direction stalls on one maintainer's hesitancy, and pi resources are personal anyway. Rejected as the only home.
- **Subtree/submodule for shared skills and rules**: heavy machinery for a single operator already integrating via merge in a fork. Rejected.
