import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const config = parse(workflow);
const steps = config.jobs.build.steps;
const step = (name) => steps.find((entry) => entry.name === name);

describe('self-use Linux amd64 release workflow', () => {
  it('supports v tags and manual builds without upstream release gates', () => {
    expect(config.on.push.tags).toEqual(['v*']);
    expect(config.on).toHaveProperty('workflow_dispatch');
    expect(Object.keys(config.jobs)).toEqual(['build']);
    expect(workflow).not.toMatch(/origin\/dev|release:validate|dry_run_id|confirm_publish/);
  });

  it('embeds the newly built frontend and both icons before compiling', () => {
    const web = step('Build embedded web UI');
    expect(web.run).toContain('npm run build');
    for (const [source, target] of [
      ['index.html', 'management.html'],
      ['favicon.ico', 'favicon.ico'],
      ['apple-touch-icon.png', 'apple-touch-icon.png'],
    ]) {
      expect(web.run).toContain(`cp apps/web/dist/${source} apps/manager-server/internal/httpapi/web/${target}`);
    }
    expect(steps.indexOf(web)).toBeLessThan(steps.indexOf(step('Build Linux amd64 binary')));
  });

  it('builds only a static linux/amd64 executable with version and commit identity', () => {
    const build = step('Build Linux amd64 binary');
    expect(build.env).toEqual({ CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' });
    expect(build.run).toContain('./cmd/cpa-manager-plus');
    expect(build.run).toContain('buildinfo.Version=${VERSION}');
    expect(build.run).toContain('buildinfo.SourceCommit=${GITHUB_SHA}');
    expect(build.run).toContain('-o ../../dist/cpa-manager-plus_linux_amd64');
    expect(config.jobs.build).not.toHaveProperty('strategy');
    expect(step('Verify binary and generate checksum').run).toContain('--version');
    expect(step('Verify binary and generate checksum').run).toContain('sha256sum');
  });

  it('uploads artifacts for manual builds and publishes tag builds only to the current fork', () => {
    expect(step('Upload build artifact').with.path).toContain('dist/cpa-manager-plus_linux_amd64');
    const publish = step('Publish tag build to this repository');
    expect(publish.if).toBe("github.ref_type == 'tag'");
    expect(publish.env.GH_REPO).toBe('${{ github.repository }}');
    expect(publish.env.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(publish.run).toContain('--verify-tag --draft');
    expect(publish.run).toContain('--clobber');
    expect(publish.run.indexOf('gh release upload')).toBeLessThan(publish.run.indexOf('gh release edit'));
  });

  it('has no container publication, update index, Telegram, or extra secrets', () => {
    expect(workflow).not.toMatch(/docker\/|ghcr\.io|DOCKERHUB|TELEGRAM|publish-update-index|packages: write/);
    expect([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1])).toEqual(['GITHUB_TOKEN']);
  });
});
