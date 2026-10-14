# rhdh-compare-branches

A GitHub Pages site that shows which files differ between the `release-2.1`
and `main` branches of the Red Hat Developer Hub repositories:

- [redhat-developer/rhdh](https://github.com/redhat-developer/rhdh)
- [redhat-developer/rhdh-plugins](https://github.com/redhat-developer/rhdh-plugins)
- [redhat-developer/rhdh-plugin-export-overlays](https://github.com/redhat-developer/rhdh-plugin-export-overlays)

For every changed file the site renders the diff. Every added or removed line
links to the pull request that last changed it (determined with `git blame`;
when no pull request can be found the commit is linked instead). For the
plugin repositories the files are grouped and collapsed per workspace, for
`rhdh` they are grouped per top-level directory.

## How it works

1. `scripts/collect.ts` clones the three repositories into `.repos/`, diffs
   `origin/release-2.1` against `origin/main`, runs `git blame` for the changed
   line ranges on both sides and writes one JSON file per repository into
   `src/data/`.
   - The pull request number is taken from the squash-merge commit subject
     (`… (#1234)`). Commits without a number are looked up through the GitHub
     API when `GITHUB_TOKEN` is set.
   - Lockfiles, vendored yarn releases and binary files are listed but their
     diff is not rendered. Diffs longer than `MAX_DIFF_LINES` (default 1500)
     are truncated.
2. The [Astro](https://astro.build) site in `src/` renders those JSON files
   into static pages.
3. `.github/workflows/deploy.yml` runs both steps and publishes `dist/` to
   GitHub Pages on every push to `main`, every day at 06:57 UTC (08:57 CEST
   or 07:57 CET, GitHub cron is always UTC), and on demand (with the
   branches as inputs).

## Local development

```sh
npm install
npm run collect        # clones into .repos/ and writes src/data/*.json
npm run dev            # http://localhost:4321/
npm run build          # static site in dist/
```

Environment variables for `npm run collect`:

| Variable         | Default       | Description                                           |
| ---------------- | ------------- | ----------------------------------------------------- |
| `BASE_BRANCH`    | `release-2.1` | Left side of the comparison                           |
| `HEAD_BRANCH`    | `main`        | Right side of the comparison                          |
| `REPOS_DIR`      | `.repos`      | Where the repositories are cloned (reused if present) |
| `OUT_DIR`        | `src/data`    | Output directory for the JSON files                   |
| `GITHUB_TOKEN`   | –             | Enables the commit → pull request API fallback        |
| `MAX_DIFF_LINES` | `1500`        | Maximum rendered diff lines per file                  |

`npm run collect rhdh` limits the run to a single repository.

## GitHub Pages setup

In the repository settings under *Pages* set the source to **GitHub Actions**.
The workflow takes care of the rest.
