# Releasing

depwave is published to npm as one package, `depwave`, built from `packages/cli` (see
[Contributing](../CONTRIBUTING.md#the-npm-package)). Releases come from tags: pushing `v<version>` runs
[`release.yml`](../.github/workflows/release.yml), which tests the packed package, publishes it to npm with
provenance, and creates the GitHub release from the version's [changelog](../CHANGELOG.md) section.

## Every release

1. **Bump the version** in `packages/cli/package.json`. Pre-releases look like `0.1.0-alpha.1`. The version is part of
   the cache key, so every user's cache is rebuilt once.
2. **Write the changelog section** `## <version> (<YYYY-MM-DD>)` in `CHANGELOG.md`. The release notes are its text.
3. **Merge to `main`** through a pull request, with CI green on every OS.
4. **Tag the merge commit and push the tag:**

   ```bash
   git tag v0.1.0-alpha.1 origin/main
   git push origin v0.1.0-alpha.1
   ```

The workflow stops before publishing if the tag and the package version differ, the changelog has no section for
the version, or any check fails. Pre-releases go to npm's `alpha` dist-tag (`publishConfig.tag`) and are marked as
pre-releases on GitHub.

## The first release

npm sets up trusted publishing from an existing package's settings, so `0.1.0-alpha.0` is published by hand, once.

1. Merge the release pull request, and replace `(unreleased)` in the changelog heading with the day's date through a
   one-line pull request. Then, on an up-to-date `main`:

   ```bash
   corepack pnpm install --frozen-lockfile
   corepack pnpm check
   corepack pnpm smoke:pack
   ```

2. Publish from `packages/cli`, after checking the dry run's name, version and tag (`depwave`, `0.1.0-alpha.0`,
   `alpha`). npm asks you to confirm with your security key in the browser:

   ```bash
   cd packages/cli
   corepack pnpm publish --dry-run
   corepack pnpm publish
   ```

   If the publish fails with an OTP or two-factor error, pack with pnpm and publish the tarball with npm instead:
   `corepack pnpm pack`, then `npm publish depwave-0.1.0-alpha.0.tgz`.

3. On npmjs.com, open the package's **Settings**, add a **trusted publisher**: GitHub Actions, repository
   `zoharyehia-sys/depwave`, workflow `release.yml`. Every later release is published by the workflow, without a
   token.
4. Push the tag `v0.1.0-alpha.0`. The workflow finds the version already on npm, skips publishing, and creates the
   GitHub release.

## After a release

- Check the install: `npx depwave@alpha --version`.
- Check the npm page shows the README, and (from the second release) the provenance badge.
- When a release is ready to be the default install, point `latest` at it: `npm dist-tag add depwave@<version> latest`.

A published version can't be republished. If something is wrong, fix it and release the next pre-release.
