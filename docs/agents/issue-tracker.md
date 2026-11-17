# GitHub Issues

Issues and specs live in `lithammer/pi-subagents`. Use `gh` from the checkout.
Before creating the first issue of a session, verify the target with
`gh repo view --json nameWithOwner`. Use `-R lithammer/pi-subagents` if needed
to select this repo.

- **Publish a ticket** with `gh issue create --title "..." --body-file <file>`.
  Add `--type <type>` when the ticket has a type.
- **Fetch a ticket** with `gh issue view <number> --json number,title,body,issueType,labels,comments`.
- **List tickets** with `gh issue list`, using `--state`, `--type`, and `--label` to scope the results.
- **Set or remove the type** with `gh issue edit <number> --type <type>` or `--remove-type`.
  The available types are `Bug`, `Feature`, `Task`, and `Epic`. See [Triage labels](triage-labels.md) for the category mapping.
- **Apply or remove labels** with `gh issue edit <number> --add-label <label>` or `--remove-label <label>`.
- **Close a ticket** by posting the explanation with `gh issue comment <number> --body-file <file>`, then running `gh issue close <number>`.

## Parent issues and blockers

Get a ticket’s numeric database ID with
`gh api repos/lithammer/pi-subagents/issues/<number> --jq .id`.

- **Link a child** with `gh api --method POST repos/lithammer/pi-subagents/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`.
  If sub-issues are unavailable, put `Part of #<parent>` at the top of the child body.
- **Add a blocker** with `gh api --method POST repos/lithammer/pi-subagents/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
  If dependencies are unavailable, put `Blocked by: #<number>` at the top of the child body.
- **Check open blockers** with `gh api repos/lithammer/pi-subagents/issues/<number> --jq .issue_dependencies_summary.blocked_by`.
  For blockers recorded in the body, read each linked issue’s state. The ticket is unblocked when every blocker is closed.

## Pull requests as a triage surface

**PRs as a request surface: no.**

If set to `yes`, list open PRs from authors outside the owner, member, and
collaborator roles. Use `gh pr view`, `gh pr view --comments`, and `gh pr diff`
to read them. Use `gh pr comment`, `gh pr edit`, and `gh pr close` for triage.

## Wayfinding

Use an issue labelled `wayfinder:map` for the map. Link tickets as sub-issues
and label them `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`,
or `wayfinder:task`. If sub-issues are unavailable, also list the children in
the map’s task list.

Pick the first open child in map order with neither an open blocker nor an
assignee. Claim it with `gh issue edit <number> --add-assignee @me`. To resolve
it, post the outcome, close the issue, and add a summary and link to
**Decisions-so-far** in the map.
