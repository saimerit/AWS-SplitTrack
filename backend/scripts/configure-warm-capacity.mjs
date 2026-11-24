import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
export const TARGET = Object.freeze({ account: "726016642280", region: "ap-south-1", stack: "splittrack-backend" });
const logicalFunctions = ["ApiFunction", "StateFunction"];
const provisionedGBSecond = 0.0000035988; // AWS Mumbai ARM quote, 24 Nov 2026.

export function parseOptions(args) {
  const options = { apply: false, enabled: true, min: 1, max: 2 };
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--apply") options.apply = true;
    else if (option === "--disable") options.enabled = false;
    else if (["--min", "--max"].includes(option) && args[index + 1]) options[option.slice(2)] = Number(args[++index]);
    else throw new Error(`Unsupported option: ${option}. Use --min N --max N, --disable or --apply.`);
  }
  if (!Number.isInteger(options.min) || !Number.isInteger(options.max) || options.min < 1 || options.min > 100 || options.max < options.min || options.max > 50000) throw new Error("Capacity must be whole numbers: 1 <= min <= 100 and min <= max <= 50000.");
  return options;
}

export function planCapacity(options, accountLimit, functions, regionalAllocated = 0) {
  if (functions.length !== 2 || new Set(functions.map(item => item.logicalId)).size !== 2 || functions.some(item => !logicalFunctions.includes(item.logicalId) || !item.functionName.startsWith(`${TARGET.stack}-${item.logicalId}-`) || item.alias !== "live")) throw new Error("Expected the existing API and state live aliases.");
  const ownProvisioned = functions.reduce((total, item) => total + (item.provisioned || 0), 0);
  const available = Math.max(0, accountLimit - 100 - regionalAllocated + ownProvisioned);
  const requested = options.enabled ? options.max * 2 : 0;
  const seconds = 30 * 86400;
  const memoryGB = functions.reduce((total, item) => total + item.memoryMB / 1024, 0);
  return {
    ...TARGET, enabled: options.enabled, minPerAlias: options.min, maxPerAlias: options.max,
    quota: { regionalConcurrency: accountLimit, regionalProvisioned: regionalAllocated, requestedMaximum: requested, available, ready: !options.enabled || requested <= available },
    warmCapacityOnlyUSD: { minimum30days: options.enabled ? Number((seconds * provisionedGBSecond * memoryGB * options.min).toFixed(2)) : 0, maximum30days: options.enabled ? Number((seconds * provisionedGBSecond * memoryGB * options.max).toFixed(2)) : 0 },
    excludes: "Invocation duration, request charges, database, logs, bandwidth and taxes. Capacity cap is not a total AWS spending cap.",
    priceReference: "https://aws.amazon.com/lambda/pricing/",
    functions,
  };
}

async function aws(...args) {
  const { stdout } = await run("aws", [...args, "--region", TARGET.region, "--output", "json", "--no-cli-pager"], { shell: false, timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : undefined;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (await aws("sts", "get-caller-identity", "--query", "Account") !== TARGET.account) throw new Error("Wrong AWS account. No changes made.");
  const stacks = await aws("cloudformation", "describe-stacks", "--stack-name", TARGET.stack);
  const stack = stacks.Stacks[0];
  if (!["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus)) throw new Error("Wait for the existing stack update to complete.");
  const [resources, account, regionalConfigs] = await Promise.all([
    aws("cloudformation", "list-stack-resources", "--stack-name", TARGET.stack),
    aws("lambda", "get-account-settings"),
    aws("lambda", "list-functions", "--query", "Functions[].FunctionName").then(async names => {
      const configs = [];
      for (let offset = 0; offset < names.length; offset += 3) {
        const pages = await Promise.all(names.slice(offset, offset + 3).map(name => aws("lambda", "list-provisioned-concurrency-configs", "--function-name", name)));
        configs.push(...pages.flatMap(page => page.ProvisionedConcurrencyConfigs || []));
      }
      return { ProvisionedConcurrencyConfigs: configs };
    }),
  ]);
  const functions = [];
  for (const logicalId of logicalFunctions) {
    const resource = resources.StackResourceSummaries.find(item => item.LogicalResourceId === logicalId && item.ResourceType === "AWS::Lambda::Function");
    if (!resource) throw new Error(`Missing existing function: ${logicalId}.`);
    const functionName = resource.PhysicalResourceId;
    const [alias, configuration] = await Promise.all([
      aws("lambda", "get-alias", "--function-name", functionName, "--name", "live"),
      aws("lambda", "get-function-configuration", "--function-name", functionName, "--qualifier", "live", "--query", "{Memory:MemorySize,Architecture:Architectures[0]}"),
    ]);
    if (configuration.Architecture !== "arm64") throw new Error("Requote provisioned capacity for the deployed architecture.");
    const own = (regionalConfigs.ProvisionedConcurrencyConfigs || []).filter(item => item.FunctionArn === alias.AliasArn);
    functions.push({ logicalId, functionName, alias: "live", version: alias.FunctionVersion, memoryMB: configuration.Memory, provisioned: own.reduce((total, item) => total + (item.RequestedProvisionedConcurrentExecutions || 0), 0) });
  }
  const allocated = (regionalConfigs.ProvisionedConcurrencyConfigs || []).reduce((total, item) => total + (item.RequestedProvisionedConcurrentExecutions || 0), 0);
  // Using unreserved concurrency is conservative when other functions reserve
  // capacity. It cannot authorize a plan that consumes their reserved slots.
  const plan = planCapacity(options, account.AccountLimit.UnreservedConcurrentExecutions, functions, allocated);
  plan.quota.regionalConcurrency = account.AccountLimit.ConcurrentExecutions;
  plan.quota.unreservedConcurrency = account.AccountLimit.UnreservedConcurrentExecutions;
  const directory = fileURLToPath(new URL("../.deployment/warm-capacity/", import.meta.url));
  await mkdir(directory, { recursive: true });
  const id = `warm-capacity-${Date.now()}`;
  await writeFile(path.join(directory, `${id}.json`), JSON.stringify(plan, null, 2));
  console.log(JSON.stringify(plan, null, 2));
  if (!options.apply) { console.log("Dry run only; no AWS resources changed."); return plan; }
  if (!plan.quota.ready) throw new Error("The regional concurrency quota cannot cover this plan. No changes made.");

  const parameterFile = path.join(directory, `${id}-parameters.json`);
  const requested = { EnableWarmConcurrency: String(options.enabled), WarmMinConcurrency: String(options.min), WarmMaxConcurrency: String(options.max) };
  await writeFile(parameterFile, JSON.stringify(stack.Parameters.map(parameter => Object.hasOwn(requested, parameter.ParameterKey)
    ? { ParameterKey: parameter.ParameterKey, ParameterValue: requested[parameter.ParameterKey] }
    : { ParameterKey: parameter.ParameterKey, UsePreviousValue: true })));
  await aws("cloudformation", "create-change-set", "--stack-name", TARGET.stack, "--change-set-name", id, "--change-set-type", "UPDATE", "--use-previous-template", "--parameters", `file://${parameterFile}`, "--capabilities", "CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND");
  let candidate;
  for (let attempt = 0; attempt < 12; attempt++) {
    candidate = await aws("cloudformation", "describe-change-set", "--stack-name", TARGET.stack, "--change-set-name", id);
    if (candidate.Status === "CREATE_COMPLETE") break;
    if (candidate.Status === "FAILED") throw new Error(candidate.StatusReason);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (candidate.Status !== "CREATE_COMPLETE") throw new Error("Change set is not ready. Inspect it before execution.");
  const allowed = new Set(["ApiFunctionAliaslive", "StateFunctionAliaslive", "ApiWarmTarget", "StateWarmTarget", "ApiWarmPolicy", "StateWarmPolicy"]);
  if (candidate.Changes.some(change => !allowed.has(change.ResourceChange.LogicalResourceId) || change.ResourceChange.Replacement === "True")) throw new Error("Unexpected resources in the warm-capacity change set. No changes executed.");
  await writeFile(path.join(directory, `${id}-change-set.json`), JSON.stringify(candidate, null, 2));
  await aws("cloudformation", "execute-change-set", "--stack-name", TARGET.stack, "--change-set-name", id);
  console.log(`Started ${id}. Verify UPDATE_COMPLETE and both aliases' provisioned status before claiming warm capacity is active.`);
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
