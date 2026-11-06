import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(repoRoot, '.github', 'workflows');
const readWorkflow = (name) => readFileSync(path.join(workflowDir, name), 'utf8').replace(/\r\n/g, '\n');
const dependabotConfig = readFileSync(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
const pullRequestTemplate = readFileSync(
  path.join(repoRoot, '.github', 'pull_request_template.md'),
  'utf8'
).replace(/\r\n/g, '\n');
const telegramScript = readFileSync(
  path.join(repoRoot, 'bin', 'release', 'send-telegram-release.sh'),
  'utf8'
);

const externalActions = (workflow) =>
  [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)@([^\s#]+)/gm)]
    .map(([, action, ref]) => ({ action, ref }))
    .filter(({ action }) => !action.startsWith('./'));

const jobBlock = (workflow, jobName) => {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start === -1) throw new Error(`Missing workflow job: ${jobName}`);
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^  \S/.test(line));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start + 1, end).join('\n');
};

describe('GitHub Actions workflow integrity', () => {
  it('pins every external action to a full commit SHA', () => {
    const workflowFiles = readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file));
    const actions = workflowFiles.flatMap((file) => externalActions(readWorkflow(file)));

    expect(actions.length).toBeGreaterThan(0);
    for (const { action, ref } of actions) {
      expect(ref, `${action} must be pinned to a 40-character commit SHA`).toMatch(
        /^[0-9a-f]{40}$/
      );
    }
  });

  it('retargets unsupported pull request targets without executing contributor code', () => {
    const workflow = readWorkflow('main-promotion.yml');
    const targetJob = jobBlock(workflow, 'retarget');

    expect(workflow).toContain('pull_request_target:');
    expect(workflow).toContain('branches-ignore:');
    expect(workflow).toMatch(/branches-ignore:\s*\n\s+- dev\s*\n\s+- v2/);
    expect(workflow).toContain("github.event.pull_request.base.ref != 'dev'");
    expect(workflow).toContain("github.event.pull_request.base.ref != 'v2'");
    expect(workflow).toContain(
      'github.event.pull_request.head.repo.full_name != github.repository'
    );
    expect(targetJob).toContain('PR_TARGET_APP_ID');
    expect(targetJob).toContain('PR_TARGET_PRIVATE_KEY');
    expect(targetJob).toContain('permission-pull-requests: write');
    expect(targetJob).toContain('const targetsV2 = current.base.ref === "v2";');
    expect(targetJob).toContain('targetsDev || targetsV2 || isDevPromotion');
    expect(targetJob).toContain('github.rest.pulls.update');
    expect(targetJob).toContain('base: "dev"');
    expect(targetJob).not.toContain('actions/checkout@');
    expect(targetJob).not.toContain('github.event.pull_request.head.sha');
  });

  it('documents dev and v2 as supported pull request targets', () => {
    expect(pullRequestTemplate).toContain('Community and 1.x maintenance PRs must target `dev`');
    expect(pullRequestTemplate).toContain('Approved v2 implementation\n> PRs target `v2`');
  });

  it('keeps the main promotion check on the pull request merge commit', () => {
    const workflow = readWorkflow('main-promotion.yml');
    const promotionJob = jobBlock(workflow, 'verify-source');

    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('- main');
    expect(promotionJob).toContain('name: Verify dev promotion source');
    expect(promotionJob).toContain("if: github.event_name == 'pull_request'");
    expect(promotionJob).toContain('HEAD_REPOSITORY');
    expect(promotionJob).toContain('HEAD_REF');
    expect(promotionJob).toContain('main accepts promotions only from');
  });

  it('reruns pull request checks after an automated base change', () => {
    const workflow = readWorkflow('pr-check.yml');
    const trigger = workflow.slice(0, workflow.indexOf('\npermissions:'));

    expect(trigger).toContain('pull_request:');
    expect(trigger).toContain('types:');
    expect(trigger).toContain('- edited');
  });

  it('keeps Demo and Docs inside the stable required-check aggregate', () => {
    const workflow = readWorkflow('pr-check.yml');
    const demoJob = jobBlock(workflow, 'demo-docs');
    const requiredJob = jobBlock(workflow, 'required');

    expect(demoJob).toContain('name: Demo and Docs');
    expect(requiredJob).toContain('- demo-docs');
    expect(requiredJob).toContain("DEMO_DOCS_RESULT: ${{ needs['demo-docs'].result }}");
    expect(requiredJob).toContain('"Demo and Docs:${DEMO_DOCS_RESULT}"');
  });

  it('always calls the security workflow and waits for it in Required checks', () => {
    const workflow = parse(readWorkflow('pr-check.yml'));
    const security = parse(readWorkflow('security.yml'));

    expect(workflow.jobs.security.uses).toBe('./.github/workflows/security.yml');
    expect(workflow.jobs.security.if).toBeUndefined();
    expect(workflow.jobs.security['continue-on-error']).toBeUndefined();
    expect(workflow.jobs.required.needs).toContain('security');
    expect(workflow.jobs.required.if).toBe('always()');
    expect(security.on).toHaveProperty('workflow_call');
    expect(security.on).toHaveProperty('schedule');
    expect(security.on).toHaveProperty('workflow_dispatch');
  });

  it.each(['success', 'failure', 'cancelled', 'skipped', '', undefined])(
    'only passes Required checks when Dependency Security succeeds (%s)',
    (securityResult) => {
      const workflow = parse(readWorkflow('pr-check.yml'));
      const step = workflow.jobs.required.steps.find(
        (candidate) => candidate.name === 'Verify applicable checks'
      );
      expect(step.env.SECURITY_RESULT).toBe('${{ needs.security.result }}');
      const env = {
        ...process.env,
        ...Object.fromEntries(Object.keys(step.env).map((key) => [key, 'skipped'])),
      };
      if (securityResult === undefined) delete env.SECURITY_RESULT;
      else env.SECURITY_RESULT = securityResult;

      const result = spawnSync('bash', ['-c', step.run], { env, encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      if (securityResult === 'success') expect(result.status, result.stderr).toBe(0);
      else expect(result.status).not.toBe(0);
    }
  );

  it('keeps release content validation inside the stable required-check aggregate', () => {
    const workflow = readWorkflow('pr-check.yml');
    const releaseJob = jobBlock(workflow, 'release-content');
    const requiredJob = jobBlock(workflow, 'required');

    expect(releaseJob).toContain('name: Release Content');
    expect(releaseJob).toContain('--changed-content --null');
    expect(releaseJob).toContain('--diff-filter=A -z');
    expect(requiredJob).toContain('- release-content');
    expect(requiredJob).toContain("RELEASE_CONTENT_RESULT: ${{ needs['release-content'].result }}");
    expect(requiredJob).toContain('"Release Content:${RELEASE_CONTENT_RESULT}"');
  });

  it('prevents metadata-action from moving the mutable latest tag', () => {
    for (const workflowName of ['release-publish-recovery.yml']) {
      const workflow = readWorkflow(workflowName);
      expect(workflow).toContain('flavor: |\n            latest=false');
    }
  });

  it('runs repository-level release and installer tests from the root test entry', () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(packageJson.scripts.test).toContain('test:web');
    expect(packageJson.scripts.test).toContain('test:repo');
    expect(packageJson.scripts['test:repo']).toBe(
      'vitest run tests/*.test.mjs --exclude tests/nativeControlScripts.test.mjs'
    );
  });

  it('uses NUL-delimited Git paths before classification and release validation', () => {
    const workflow = readWorkflow('pr-check.yml');

    expect(workflow).toContain('git diff --name-only --no-renames -z');
    expect(workflow).toContain('git show --pretty=format: --name-only --no-renames -z');
    expect(workflow).toContain('classify-pr-checks.mjs --null');
  });

  it('preserves false-valued GitHub API booleans during release recovery', () => {
    const workflow = readWorkflow('release-publish-recovery.yml');
    const booleanFilter = 'if type == "boolean" then tostring else empty end';

    expect(workflow).toContain(`.expired | ${booleanFilter}`);
    expect(workflow.match(new RegExp(`\\.draft \\| ${booleanFilter}`, 'g'))).toHaveLength(2);
    expect(workflow).not.toMatch(/\.(?:expired|draft)\s*\/\/\s*empty/);
  });

  it('allows release recovery to revalidate its prepared draft before publishing images', () => {
    const workflow = readWorkflow('release-publish-recovery.yml');
    const dockerJob = jobBlock(workflow, 'build_and_push_docker');
    const stepsOffset = dockerJob.indexOf('\n    steps:');
    const jobConfiguration = dockerJob.slice(0, stepsOffset);

    expect(jobConfiguration).toContain('contents: write');
    expect(jobConfiguration).toContain('packages: write');
    expect(dockerJob).toContain(
      'name: Revalidate prepared GitHub Release before registry mutation'
    );
    expect(dockerJob).toContain(
      '"${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"'
    );
  });

  it('provides a validated explicit Telegram recovery workflow', () => {
    const workflow = readWorkflow('release-telegram-recovery.yml');
    const notifyJob = jobBlock(workflow, 'notify');
    const stepsOffset = notifyJob.indexOf('\n    steps:');
    const jobConfiguration = notifyJob.slice(0, stepsOffset);
    const deliveryStep = notifyJob.slice(notifyJob.indexOf('- name: Send Telegram'));

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('confirm_resend:');
    expect(workflow).toContain('type: boolean');
    expect(notifyJob).toContain('refs/heads/main');
    expect(notifyJob).toContain('name: Validate tagged release provenance');
    expect(notifyJob).not.toContain('git checkout --detach');
    expect(notifyJob).toContain('git merge-base --is-ancestor "${RELEASE_SHA}" origin/main');
    expect(notifyJob).toContain('git merge-base --is-ancestor "${release_dev_sha}" origin/dev');
    expect(notifyJob).toContain('--main-ref "${RELEASE_SHA}"');
    expect(notifyJob).toContain('--dev-ref "${release_dev_sha}"');
    expect(notifyJob).toContain('git show "${release_sha}:docs/release-posts/');
    expect(notifyJob).toContain('--mode metadata');
    expect(jobConfiguration).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(jobConfiguration).not.toContain('TELEGRAM_CHAT_ID');
    expect(deliveryStep).toContain("TELEGRAM_STRICT: 'true'");
    expect(deliveryStep).toContain(
      'RELEASE_POST_PATH: ${{ steps.release_source.outputs.release_post }}'
    );
    expect(deliveryStep).toContain('run: bash bin/release/send-telegram-release.sh');
    expect(telegramScript).not.toContain('--retry');
    expect(telegramScript).not.toContain('--retry-all-errors');
  });

  it('does not retain the main-only standalone Demo and Docs workflow', () => {
    expect(existsSync(path.join(workflowDir, 'demo-docs-check.yml'))).toBe(false);
  });

  it('keeps GitHub Actions dependency updates on the integration branch', () => {
    expect(dependabotConfig).toContain('package-ecosystem: github-actions');
    expect(dependabotConfig).toContain('target-branch: dev');
    expect(dependabotConfig).toContain('interval: weekly');
  });
});
