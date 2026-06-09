import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "../state/fs";
import type { DeploymentBootstrapDiagnostics, DeploymentBootstrapTask, DetectedStack } from "./types";

export async function analyzeDeploymentBootstrap(input: {
  deploymentRoot: string;
  stack: DetectedStack;
}): Promise<DeploymentBootstrapDiagnostics> {
  const tasks: DeploymentBootstrapTask[] = [];
  const warnings: string[] = [];

  if (await hasPrisma(input.deploymentRoot)) {
    tasks.push({
      kind: "prisma",
      command: packageManagerRun(input.stack.packageManager, "prisma migrate deploy"),
      automatic: false,
      reason: "Prisma schema detected; databases may require migrations before the app can serve requests.",
    });
  }

  if (input.stack.framework === "django" && await hasFile(input.deploymentRoot, "manage.py")) {
    tasks.push({
      kind: "django",
      command: "python manage.py migrate --noinput",
      automatic: false,
      reason: "Django manage.py detected; pending migrations can surface as missing-table errors at boot or first request.",
    });
  }

  if (input.stack.framework === "rails" && await hasDirectory(input.deploymentRoot, "db/migrate")) {
    tasks.push({
      kind: "rails",
      command: "bundle exec rails db:migrate",
      automatic: false,
      reason: "Rails migrations detected; pending migrations can cause boot or request failures.",
    });
  }

  if (input.stack.framework === "laravel" && await hasDirectory(input.deploymentRoot, "database/migrations")) {
    tasks.push({
      kind: "laravel",
      command: "php artisan migrate --force",
      automatic: false,
      reason: "Laravel migrations detected; pending migrations can cause database/table failures.",
    });
  }

  if (await containsAny(input.deploymentRoot, ["flyway.conf", "flyway.toml"])) {
    tasks.push({
      kind: "flyway",
      command: "flyway migrate",
      automatic: false,
      reason: "Flyway configuration detected; schema migrations may need to run before deployment is healthy.",
    });
  }

  if (await containsAny(input.deploymentRoot, ["liquibase.properties", "liquibase.yml", "liquibase.yaml"])) {
    tasks.push({
      kind: "liquibase",
      command: "liquibase update",
      automatic: false,
      reason: "Liquibase configuration detected; schema migrations may need to run before deployment is healthy.",
    });
  }

  if (tasks.length > 0) {
    warnings.push("Bootstrap tasks are diagnostic only; loom does not run migrations automatically.");
  }

  return { tasks, warnings };
}

async function hasPrisma(root: string): Promise<boolean> {
  return hasFile(root, "prisma/schema.prisma") || containsPackageScript(root, /prisma\s+migrate|prisma\s+db\s+push/i);
}

async function containsPackageScript(root: string, pattern: RegExp): Promise<boolean> {
  const packagePath = path.join(root, "package.json");
  if (!(await pathExists(packagePath))) {
    return false;
  }
  try {
    const pkg = JSON.parse(await fs.readFile(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
    return Object.values(pkg.scripts ?? {}).some((script) => typeof script === "string" && pattern.test(script));
  } catch {
    return false;
  }
}

async function containsAny(root: string, names: string[]): Promise<boolean> {
  for (const name of names) {
    if (await pathExists(path.join(root, name))) {
      return true;
    }
  }
  return false;
}

async function hasFile(root: string, relativePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(root, relativePath));
    return stat.isFile();
  } catch {
    return false;
  }
}

async function hasDirectory(root: string, relativePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(root, relativePath));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function packageManagerRun(packageManager: DetectedStack["packageManager"], command: string): string {
  switch (packageManager) {
    case "pnpm":
      return `pnpm exec ${command}`;
    case "yarn":
      return `yarn ${command}`;
    case "bun":
      return `bunx ${command}`;
    case "npm":
    default:
      return `npx ${command}`;
  }
}
