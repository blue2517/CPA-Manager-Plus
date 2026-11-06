import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authorization = readFileSync(
  path.join(repoRoot, 'bin', 'release', 'authorize-release-dispatch.mjs'),
  'utf8'
);

describe('legacy release recovery authorization', () => {
  it('binds publish authorization to the exact main SHA and successful prior dry-run', () => {
    expect(authorization).toContain('Publish dispatch requires expected_sha to match the exact main SHA');
    expect(authorization).toContain('Publish dispatch requires a successful dry_run_id');
    expect(authorization).toContain('The supplied run is not the expected successful dry-run');
    expect(authorization).toContain("run?.head_branch !== 'main'");
    expect(authorization).toContain("run?.path !== releaseWorkflowPath");
    expect(authorization).toContain('confirmPublish !== true');
  });

  it('creates the tag inside the publish run instead of depending on recursive tag events', () => {
    expect(authorization).toContain("mode === 'publish' ? 'create-tag' : 'validate'");
    expect(authorization).toContain("ref: `refs/tags/${releaseTag}`");
    expect(authorization).toContain("method: 'POST'");
    expect(authorization).toContain('validateTagRef({ ref: verifiedTag, releaseTag, releaseSha })');
  });

  it('allows reruns to reuse only the exact tag created by the original publish attempt', () => {
    expect(authorization).toContain('Release workflow attempt must be a positive integer');
    expect(authorization).toContain('Release tag already exists before first publish attempt');
    expect(authorization).toContain('currentAttempt === 1');
    expect(authorization).toContain('tagReused: true');
    expect(authorization).toContain('does not point directly to');
  });

});