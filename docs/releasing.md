# Release preparation

Nothing in this document authorizes a public repository, push, registry upload,
new repository, repository deletion or history rewrite. The source and package
can be reviewed locally while `private: true` blocks npm publication.

## Establish public source history

The development repository used conversation checkpoints stored in custom Git
refs. Removing capture configuration, session directories or refs does not
establish that a hosting service has erased historical objects. Do not make
that private repository public on the strength of working-tree cleanup alone.
GitHub documents the remaining references and caches in its
[history-removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

The recommended first public baseline is an audited snapshot of the current
source, without `.git`, conversation captures, ignored files, dependencies or
build outputs. Keep the old repository private for historical recovery. Extract
the reviewed snapshot into an empty directory, initialize a new repository and
inspect its complete file list before creating any remote or pushing.

The owner has created a separate public `kequtech/tenon-orm` repository for the
clean baseline and retained previous development history privately. Package
metadata and README links already target the new repository. Never copy old refs
or Git hooks into the new baseline, or mirror-push the development repository to
the public one. Review the clean initial commit before pushing it.

A Git source baseline is separate from Tenon's SQL `baseline capture` feature.
No database baseline changes are needed for this repository cleanup.

## Review and pack

From a clean checkout with development dependencies and the dedicated test
database available:

```sh
npm ci
npm run check
npm pack --dry-run
npm pack --pack-destination /path/to/review-directory
```

`prepack` builds from clean output directories and marks the CLI executable.
`files` in package metadata
allows only compiled JavaScript and declarations; npm also includes README,
LICENSE and package.json. `.npmignore` excludes development/configuration files,
local environments, keys and conversation captures as an additional safeguard.
Source maps are not emitted. The consumer test checks the actual tarball's file
manifest, installed license, CLI executable, public exports and production
runtime without development typings. No credentials belong in registry config
committed to this repository.

Review the actual archive with `tar -tzf <package.tgz>` and install that archive
in a consumer. Verify README examples against the final built package. Keep
application-specific migrations and generated application files out of the npm
package. Library tests/fixtures are source repository material only.

## Approve the release

Before the first npm release:

1. Approve the source repository and its visibility independently of npm.
2. Verify the PostgreSQL 16/18 CI results and resolve known release blockers.
3. Choose the version and release channel; update metadata and lockfile together.
4. Confirm the npm `@kequtech` organization and publisher permissions.
5. Remove `private: true` only for the approved release and inspect the final diff
   and tarball again. `publishConfig` already selects the public npm registry and
   public access. It does not publish anything by itself.
6. Publish explicitly, selecting a prerelease tag when applicable. Prefer a
   verified publishing identity; do not add a release workflow or credentials
   before choosing the publishing method.

`prepublishOnly` runs the complete check suite, including the dedicated database
preflight. Publishing an already-reviewed tarball is a separate explicit action;
lifecycle hooks are not a substitute for reviewing that artifact.
