---
name: fieldtheory
description: >
  Search and inspect a user's locally synced Field Theory X/Twitter bookmarks through
  the ft CLI. Use when the user mentions Field Theory, saved X posts, Twitter
  bookmarks, or asks to find or analyze something they bookmarked. General X research
  and live account actions belong to other tools.
license: MIT
metadata:
  tags: field-theory, bookmarks, x, twitter, local-search, research
  upstream: afar1/fieldtheory-cli
---

# Field Theory — search local bookmarks

Use Field Theory's CLI as the interface to the user's private, locally synced bookmark
collection. Keep ordinary use read-only and return a compact synthesis with the relevant
post links instead of raw collection dumps.

## Access boundary

- Read bookmark data through `ft` commands only. Never inspect browser cookie stores,
  OAuth token files, raw SQLite databases, JSONL caches, or other private Field Theory
  files directly.
- An explicit request to perform an action authorizes that action. Otherwise, get
  authorization immediately before installing or updating Field Theory, running `ft auth`,
  `ft sync`, `ft classify`, changing its model, scheduling it, or making any other
  mutation. Classification may send bookmark content to a configured external LLM.
- Keep credentials and raw private data out of messages, logs, commits, and tool output.

## Read-only workflow

1. Check whether `ft` is available. If it is missing, say that the Field Theory CLI is
   not installed or not on the runner's `PATH`, link to
   <https://github.com/afar1/fieldtheory-cli>, and offer setup. Do not fall back to raw
   Field Theory files.
2. Run `ft status --json` to confirm that a bookmark index exists and understand its
   freshness. If setup or sync is needed, explain that sync accesses the user's X session
   or OAuth account and wait for authorization unless the user already requested it.
3. Search broadly, refine with the user's stated filters, and inspect only the promising
   bookmark IDs:

   ```bash
   ft search "<query>" --limit 20 --json
   ft search "<query>" --author <handle> --after YYYY-MM-DD --before YYYY-MM-DD --limit 20 --json
   ft list --query "<query>" --category <category> --domain <domain> --limit 30 --offset 0 --json
   ft list --folder "<folder>" --after YYYY-MM-DD --before YYYY-MM-DD --limit 30 --json
   ft show <bookmark-id> --json
   ```

   Use only the filters needed for the request. Keep limits bounded; paginate with
   `--offset` only when the user needs broader coverage.
4. Summarize the findings and preserve provenance: include the useful post URLs and note
   material filters, date bounds, or stale-index limitations. If nothing matches, report
   that result and offer a refined search or an authorized sync rather than broadening the
   task silently.

## Setup and changes

When the user explicitly asks for setup or another state-changing operation, inspect the
current upstream instructions and the installed command's `--help` before acting. Treat
the npm package as third-party executable code, prefer a reviewed pinned version, verify
the installed version and a harmless command, and report what local data or account access
the approved operation uses. Do not add Field Theory as a SmolPaws package dependency.
