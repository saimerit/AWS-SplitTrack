import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TARGET = Object.freeze({ account: '726016642280', region: 'ap-south-1', stack: 'splittrack-backend', retentionDays: 30 });
const LOGICAL_FUNCTIONS = ['ApiFunction', 'AuthFunction', 'ChangelogFunction', 'HealthFunction', 'StateFunction'];
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseOptions(args) {
  const options = { apply: false, profile: undefined };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') options.apply = true;
    else if (args[index] === '--profile' && args[index + 1] && !args[index + 1].startsWith('--')) options.profile = args[++index];
    else throw new Error(`Unsupported or incomplete option: ${args[index]}. Use --apply and/or --profile NAME.`);
  }
  return options;
}

export function validateFunctions(resources) {
  const functions = resources.filter(resource => resource.ResourceType === 'AWS::Lambda::Function');
  if (functions.length !== LOGICAL_FUNCTIONS.length || new Set(functions.map(resource => resource.LogicalResourceId)).size !== LOGICAL_FUNCTIONS.length) {
    throw new Error('The stack must contain exactly the five expected Lambda functions. No retention policies were changed.');
  }
  return LOGICAL_FUNCTIONS.map(logicalId => {
    const resource = functions.find(item => item.LogicalResourceId === logicalId);
    const prefix = `${TARGET.stack}-${logicalId}-`;
    if (!resource?.PhysicalResourceId?.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(resource.PhysicalResourceId)) {
      throw new Error(`Unexpected deployed function for ${logicalId}. No retention policies were changed.`);
    }
    if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(resource.ResourceStatus)) throw new Error(`${logicalId} is not in a completed deployment state.`);
    return { logicalId, functionName: resource.PhysicalResourceId, logGroupName: `/aws/lambda/${resource.PhysicalResourceId}` };
  });
}

export function planRetention(group, streams, now = Date.now()) {
  const timestamps = streams.map(stream => stream.firstEventTimestamp).filter(Number.isFinite);
  const earliestEventMs = timestamps.length ? Math.min(...timestamps) : null;
  const alreadyConfigured = group.retentionInDays === TARGET.retentionDays;
  // Extending an existing shorter policy cannot remove additional history.
  const canExpireMore = !alreadyConfigured && (!group.retentionInDays || group.retentionInDays > TARGET.retentionDays);
  if (canExpireMore && streams.length && timestamps.length !== streams.length) {
    throw new Error(`Cannot verify the oldest events in ${group.logGroupName}; no retention policies were changed.`);
  }
  if (canExpireMore && earliestEventMs !== null && earliestEventMs < now - TARGET.retentionDays * DAY_MS) {
    throw new Error(`Stored event metadata in ${group.logGroupName} is older than 30 days; no retention policies were changed.`);
  }
  return {
    logGroupName: group.logGroupName,
    createdAt: new Date(group.creationTime).toISOString(),
    earliestEventAt: earliestEventMs === null ? null : new Date(earliestEventMs).toISOString(),
    streamCount: streams.length,
    storedBytes: group.storedBytes ?? 0,
    previousRetentionDays: group.retentionInDays ?? null,
    retentionDays: TARGET.retentionDays,
    changeRequired: !alreadyConfigured,
  };
}

function aws(args, options, json = true) {
  const commandArgs = [...args, '--region', TARGET.region, '--output', 'json', '--no-cli-pager'];
  if (options.profile) commandArgs.push('--profile', options.profile);
  return new Promise((resolve, reject) => {
    const child = spawn('aws', commandArgs, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`AWS CLI ${args[0]} ${args[1]} failed: ${stderr.trim()}`));
      try { resolve(json ? JSON.parse(stdout) : stdout.trim()); }
      catch { reject(new Error(`AWS CLI ${args[0]} ${args[1]} returned invalid JSON.`)); }
    });
  });
}

async function describeGroup(name, options) {
  const groups = await aws(['logs', 'describe-log-groups', '--log-group-name-prefix', name, '--query', 'logGroups[].{logGroupName:logGroupName,creationTime:creationTime,retentionInDays:retentionInDays,storedBytes:storedBytes}'], options);
  const exact = groups.filter(group => group.logGroupName === name);
  if (exact.length !== 1) throw new Error(`Expected the existing exact log group ${name}; no new log groups will be created.`);
  return exact[0];
}

async function auditFunction(resource, options, now) {
  const [configuration, group, streams] = await Promise.all([
    aws(['lambda', 'get-function-configuration', '--function-name', resource.functionName, '--query', '{FunctionName:FunctionName,LogGroup:LoggingConfig.LogGroup}'], options),
    describeGroup(resource.logGroupName, options),
    aws(['logs', 'describe-log-streams', '--log-group-name', resource.logGroupName, '--query', 'logStreams[].{firstEventTimestamp:firstEventTimestamp}'], options),
  ]);
  if (configuration.FunctionName !== resource.functionName || configuration.LogGroup !== resource.logGroupName) throw new Error(`Unexpected logging destination for ${resource.logicalId}.`);
  return { logicalId: resource.logicalId, ...planRetention(group, streams, now) };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const account = await aws(['sts', 'get-caller-identity', '--query', 'Account'], options);
  if (account !== TARGET.account) throw new Error(`Wrong AWS account: expected ${TARGET.account}. No retention policies were changed.`);
  const resources = await aws(['cloudformation', 'describe-stack-resources', '--stack-name', TARGET.stack, '--query', 'StackResources[].{LogicalResourceId:LogicalResourceId,PhysicalResourceId:PhysicalResourceId,ResourceType:ResourceType,ResourceStatus:ResourceStatus}'], options);
  const functions = validateFunctions(resources);
  const now = Date.now(), plans = [];
  // Preflight every group before the first write. Limit CLI concurrency to three.
  for (const resource of functions) plans.push(await auditFunction(resource, options, now));
  const report = { auditedAt: new Date(now).toISOString(), mode: options.apply ? 'apply' : 'dry-run', ...TARGET, groups: plans };
  console.log(JSON.stringify(report, null, 2));
  if (options.apply) {
    for (const plan of plans.filter(item => item.changeRequired)) {
      await aws(['logs', 'put-retention-policy', '--log-group-name', plan.logGroupName, '--retention-in-days', String(TARGET.retentionDays)], options, false);
    }
    report.verifiedGroups = [];
    for (const plan of plans) {
      const group = await describeGroup(plan.logGroupName, options);
      if (group.retentionInDays !== TARGET.retentionDays) throw new Error(`Retention verification failed for ${plan.logGroupName}.`);
      report.verifiedGroups.push({ logGroupName: plan.logGroupName, retentionDays: group.retentionInDays });
    }
    console.log(`Verified 30-day retention on the five existing ${TARGET.stack} Lambda log groups.`);
  } else console.log('Dry run only. Use --apply to update these five existing policies.');
  const directory = fileURLToPath(new URL('../.deployment/log-retention/', import.meta.url));
  await mkdir(directory, { recursive: true });
  const evidencePath = path.join(directory, `${report.auditedAt.replace(/[:.]/g, '-')}-${report.mode}.json`);
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Sanitized metadata evidence: ${evidencePath}`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
