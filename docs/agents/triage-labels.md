# Triage labels

Use GitHub issue types for categories and labels for triage states.

| Role              | In GitHub               | Meaning                                                  |
| ----------------- | ----------------------- | -------------------------------------------------------- |
| `bug`             | Type `Bug`              | Something is broken.                                     |
| `enhancement`     | Type `Feature`          | New feature or improvement.                              |
| `needs-triage`    | Label `needs-triage`    | A maintainer needs to evaluate the issue.                |
| `needs-info`      | Label `needs-info`      | The issue needs more information from the reporter.      |
| `ready-for-agent` | Label `ready-for-agent` | The issue is specified enough for an agent to implement. |
| `ready-for-human` | Label `ready-for-human` | A human needs to implement the issue.                    |
| `wontfix`         | Label `wontfix`         | The issue will be closed without a fix.                  |

When a skill refers to a role, use the type or label from the table. An issue
holds one type, so `gh issue edit <number> --type Bug` replaces its current type.
