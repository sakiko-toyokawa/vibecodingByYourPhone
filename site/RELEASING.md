# Releasing the Website

The website (landing pages + remote relay client) is deployed to GitHub Pages separately from the npm package. This allows coordinating compatibility between the remote client and server versions.

## When to Release

Release the website when:
- Landing page content changes (index.html, privacy.html, etc.)
- Remote relay client changes that are compatible with released npm versions
- Breaking changes require coordination with an npm release

## Release Process

1. Update `site/CHANGELOG.md` with a new version section:
   ```markdown
   ## [site-v1.1.0] - 2025-02-01

   ### Added
   - New feature description

   ### Fixed
   - Bug fix description
   ```

2. Commit the changelog update

3. Tag and push:
   ```bash
   git tag site-v1.1.0
   git push origin site-v1.1.0
   ```

The GitHub Actions workflow will build and deploy to GitHub Pages.

## Manual Deployment

You can also trigger a deployment manually from the GitHub Actions UI using workflow_dispatch. This deploys the current main branch without creating a tag.

## Version Compatibility

The remote relay client (`/remote`) must be compatible with npm package versions users are running. When making breaking protocol changes:

1. Release the npm package first with backwards compatibility
2. Release the website once users have had time to update
3. Or coordinate simultaneous releases if needed
