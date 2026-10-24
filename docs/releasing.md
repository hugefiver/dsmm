# DSMM release

The standalone repository publishes from `.github/workflows/release.yml` when a
`vX.Y.Z` tag is pushed. The tag must equal `v` plus the exact `package.json`
version. The workflow never rewrites package metadata from a tag.

## External setup

Before publication, npm Trusted Publishing must be configured for `@dsmm/dsmm`
with these exact values:

- provider: GitHub Actions
- repository: `hugefiver/dsmm`
- workflow filename: `release.yml`
- permission: publish

The npm package and maintainer ownership must already exist. The workflow uses
GitHub's OIDC token and does not use a long-lived npm token. Repository Actions
must also permit the workflow's job-scoped `contents: write` permission so it can
create a GitHub Release.

## Verification and publication

The read-only verification job uses Node.js 24 and pnpm 11.9.0, installs the
standalone lockfile with `--frozen-lockfile`, then runs the build, source
typecheck, tests, offline frontend resource check, generated-role consistency
check, and package creation. It uploads an exact three-file artifact containing
the packed tarball, `SHA256SUMS.txt`, and an identity record bound to the tag,
commit, run and attempt.

The dependent publication job has `contents: write` and `id-token: write`. It
doesn't check out the repository, install project dependencies, or execute project
code. It downloads the artifact, rechecks its exact file set, checksum, workflow
identity and packed npm name/version, and then rechecks both publication surfaces.
Only the tarball and `SHA256SUMS.txt` become GitHub Release assets.

Before building and again immediately before publication, the workflow refuses a
tag/version mismatch, an npm version that already exists, or an existing GitHub
Release for the tag. npm publication uses `--provenance`, public access, the public
registry, disabled lifecycle scripts and no fetch retries. GitHub Release creation
uses the same tarball and `SHA256SUMS.txt`; no overwrite option is used.
Concurrency is serialized without cancelling an in-progress release.

## Failure handling

npm and GitHub Release are distinct immutable publication surfaces. A failure
after either surface is published is a partial release, not authorization to move
or recreate the tag, republish the npm version, or replace an asset. Report the
exact workflow result and use a separately authorized new version/tag.

Publication does not install DSMM. Installation requires DSH
`>=0.2.1-rc.2 <0.3.0` and separate authorization, and must preserve accounts, credentials,
history and unrelated configuration.
