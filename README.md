# Philharmonic

Philharmonic is an experimental coding-agent orchestrator inspired by OpenAI Symphony, built around GitHub Projects v2 and Claude Code.

## Goal

Turn GitHub Project items into isolated Claude Code implementation runs, then produce pull requests for human review.

## Initial scope

- Poll GitHub Projects v2 for candidate issues
- Create isolated workspaces or git worktrees per task
- Run Claude Code in headless mode
- Capture logs, results, and costs
- Push branches and open pull requests
- Update GitHub Project item status
- Keep safe defaults: PR creation is automated, merging is human-approved

## Status

Just getting started.
