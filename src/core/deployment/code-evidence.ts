import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { technicalBaselineSchema, type TechnicalBaseline } from "../contracts";
import { getActiveLocator, loadProjectStatus } from "../state/delivery";
import { ensureDir, pathExists, readJsonFile, writeJsonAtomic } from "../state/fs";
import { technicalBaselinePath, toProjectRelative } from "../state/paths";
import { serviceDefinition } from "./detect";
import { getDeploymentPaths } from "./paths";
import type {
  DependencyService,
  DependencyServiceKind,
  DeploymentCodeEvidence,
  DeploymentCodeEvidenceSummary,
  DeploymentCodeEvidenceTrack,
  DeploymentEvidenceConfidence,
  DeploymentEvidenceRef,
  DeploymentEvidenceValue,
  DeployConflict,
  DeployMissingFact,
  DetectedStack,
} from "./types";

const execFileAsync = promisify(execFile);

type BaselineInfo = {
  baseline: TechnicalBaseline;
  ref: string;
};

type IndexedFile = {
  relativePath: string;
  absolutePath: string;
  kind: "manifest" | "config" | "env" | "source" | "deploy_asset";
};

type FileSignal = {
  file: IndexedFile;
  text: string;
  lower: string;
};

type ServiceCandidate = {
  kind: DependencyServiceKind;
  strength: "driver" | "runtime_config" | "explicit_provider" | "env";
  evidence: DeploymentEvidenceRef[];
};

const MAX_SOURCE_FILES = 250;
const MAX_SOURCE_FILE_BYTES = 96_000;
const MAX_DECLARATION_FILE_BYTES = 512_000;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".loom",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".vercel",
  "dist",
  "build",
  "coverage",
  "target",
  "bin",
  "obj",
  "tmp",
  "log",
  "storage",
]);

const DECLARATION_BASENAMES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "composer.json",
  "Gemfile",
  "application.yml",
  "application.yaml",
  "application.properties",
  "appsettings.json",
  "appsettings.Development.json",
  ".env.example",
  ".env.sample",
  ".env.local.example",
  ".env.template",
  ".env.dist",
  "schema.prisma",
  "Dockerfile",
  "dockerfile",
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
]);

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".java",
  ".kt",
  ".py",
  ".go",
  ".cs",
  ".php",
  ".rb",
  ".yml",
  ".yaml",
  ".properties",
  ".toml",
]);

const DATABASE_SERVICE_KINDS = new Set<DependencyServiceKind>(["postgres", "mysql", "mongodb"]);

export async function loadDeploymentTechnicalBaseline(projectRoot: string): Promise<BaselineInfo | null> {
  const deliveryIds = new Set<string>();
  try {
    const locator = await getActiveLocator(projectRoot);
    deliveryIds.add(locator.deliveryId);
  } catch {
    // Deploy can be used before a loom delivery exists.
  }
  try {
    const status = await loadProjectStatus(projectRoot);
    if (status.activeDeliveryId) deliveryIds.add(status.activeDeliveryId);
    if (status.lastCompletedDeliveryId) deliveryIds.add(status.lastCompletedDeliveryId);
  } catch {
    // Missing or partial state simply means no baseline is available.
  }

  for (const deliveryId of deliveryIds) {
    try {
      const absolutePath = technicalBaselinePath(projectRoot, deliveryId);
      if (!(await pathExists(absolutePath))) {
        continue;
      }
      const baseline = technicalBaselineSchema.parse(await readJsonFile(absolutePath));
      return {
        baseline,
        ref: toProjectRelative(projectRoot, absolutePath),
      };
    } catch {
      continue;
    }
  }
  return null;
}

export async function buildDeploymentCodeEvidence(input: {
  projectRoot: string;
  stack: DetectedStack;
  technicalBaseline: BaselineInfo | null;
}): Promise<DeploymentCodeEvidence> {
  const files = await indexProjectFiles(input.projectRoot);
  const signals = await readFileSignals(files);
  const baselineExpectation = normalizeBaselineExpectation(input.technicalBaseline?.baseline ?? null);
  const runtimeFacts = runtimeFactsFor(input.stack, signals);
  const serviceCandidates = collectServiceCandidates(signals);
  const embeddedStores = collectEmbeddedStores(signals);
  const databaseRuntimeEvidence = collectDatabaseRuntimeEvidence(signals);
  const dependencyServices = resolveDependencyServices({
    baselineExpectation,
    serviceCandidates,
    embeddedStores,
    databaseRuntimeEvidence,
    stack: input.stack,
  });
  const existingDeployAssets = signals
    .filter((signal) => signal.file.kind === "deploy_asset")
    .map((signal) => evidence(signal.file.relativePath, "Existing deployment asset found."));
  const conflicts = conflictFacts(baselineExpectation, dependencyServices.services, embeddedStores);
  const missingFacts = missingFactsFor({
    baselineExpectation,
    dependencyServices,
    databaseRuntimeEvidence,
  });
  const warnings = warningsFor(baselineExpectation, dependencyServices.services, embeddedStores);
  const generatedAt = new Date().toISOString();
  const evidenceId = `deploy-code-evidence-${Date.now()}`;
  const partial = {
    schemaVersion: 1 as const,
    evidenceId,
    generatedAt,
    fingerprint: "",
    projectRoot: input.projectRoot,
    technicalBaselineRef: input.technicalBaseline?.ref ?? null,
    baselineExpectation,
    runtimeFacts,
    buildStartFacts: buildStartFactsFor(input.stack),
    dependencyFacts: {
      services: dependencyServices.services,
      embeddedStores,
      ambiguous: dependencyServices.ambiguous,
    },
    environmentFacts: {
      required: databaseRuntimeEvidence,
      provided: [],
      generated: Object.assign({}, ...dependencyServices.services.map((service) => service.value.connectionEnv)),
      missing: missingFacts.flatMap((fact) => fact.evidence),
    },
    existingDeployAssets,
    conflicts,
    missingFacts,
    warnings,
  };
  return {
    ...partial,
    fingerprint: fingerprintEvidence(partial),
  };
}

export async function writeDeploymentCodeEvidence(
  projectRoot: string,
  evidenceValue: DeploymentCodeEvidence,
): Promise<DeploymentCodeEvidenceSummary> {
  const paths = getDeploymentPaths(projectRoot);
  await ensureDir(paths.evidenceDir);
  await writeJsonAtomic(paths.codeEvidenceFile, evidenceValue);
  return summarizeDeploymentCodeEvidence(projectRoot, evidenceValue);
}

export function summarizeDeploymentCodeEvidence(
  projectRoot: string,
  evidenceValue: DeploymentCodeEvidence,
): DeploymentCodeEvidenceSummary {
  return {
    ref: toProjectRelative(projectRoot, getDeploymentPaths(projectRoot).codeEvidenceFile),
    fingerprint: evidenceValue.fingerprint,
    technicalBaselineRef: evidenceValue.technicalBaselineRef,
    runtimeFacts: {
      web: evidenceValue.runtimeFacts.web?.value ?? null,
      backend: evidenceValue.runtimeFacts.backend?.value ?? null,
      fullstack: evidenceValue.runtimeFacts.fullstack?.value ?? null,
    },
    dependencyServices: evidenceValue.dependencyFacts.services.map((service) => ({
      kind: service.value.kind,
      serviceName: service.value.serviceName,
      reason: service.value.reason,
    })),
    embeddedStores: evidenceValue.dependencyFacts.embeddedStores.map((store) => store.value),
    warningCount: evidenceValue.warnings.length,
    conflictCount: evidenceValue.conflicts.length,
    missingFactCount: evidenceValue.missingFacts.length,
  };
}

export function applyDeploymentCodeEvidenceToStack(
  stack: DetectedStack,
  evidenceValue: DeploymentCodeEvidence,
): DetectedStack {
  return {
    ...stack,
    services: evidenceValue.dependencyFacts.services.map((service) => service.value),
  };
}

async function indexProjectFiles(projectRoot: string): Promise<IndexedFile[]> {
  const gitFiles = await gitTrackedFiles(projectRoot);
  const candidates = gitFiles ?? await walkedFiles(projectRoot);
  const indexed: IndexedFile[] = [];
  let sourceCount = 0;
  for (const relativePath of candidates.sort(comparePaths)) {
    if (isIgnoredPath(relativePath)) {
      continue;
    }
    const kind = classifyIndexedFile(relativePath);
    if (!kind) {
      continue;
    }
    if (kind === "source" && sourceCount >= MAX_SOURCE_FILES) {
      continue;
    }
    if (kind === "source") {
      sourceCount += 1;
    }
    indexed.push({
      relativePath,
      absolutePath: path.join(projectRoot, relativePath),
      kind,
    });
  }
  return indexed;
}

async function gitTrackedFiles(projectRoot: string): Promise<string[] | null> {
  try {
    const result = await execFileAsync("git", ["-C", projectRoot, "ls-files", "--cached", "--others", "--exclude-standard"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const files = String(result.stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

async function walkedFiles(projectRoot: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const absolutePath = path.join(dir, entry.name);
      const relativePath = toProjectRelative(projectRoot, absolutePath);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        output.push(relativePath);
      }
    }
  }
  await walk(projectRoot);
  return output;
}

async function readFileSignals(files: IndexedFile[]): Promise<FileSignal[]> {
  const signals: FileSignal[] = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(file.absolutePath);
      const maxBytes = file.kind === "source" ? MAX_SOURCE_FILE_BYTES : MAX_DECLARATION_FILE_BYTES;
      if (stat.size > maxBytes) {
        continue;
      }
      const text = await fs.readFile(file.absolutePath, "utf8");
      signals.push({
        file,
        text,
        lower: text.toLowerCase(),
      });
    } catch {
      continue;
    }
  }
  return signals;
}

function classifyIndexedFile(relativePath: string): IndexedFile["kind"] | null {
  const normalized = relativePath.split(path.sep).join("/");
  const basename = path.basename(normalized);
  if (["Dockerfile", "dockerfile", "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"].includes(basename)) {
    return "deploy_asset";
  }
  if (DECLARATION_BASENAMES.has(basename) || /\.csproj$/i.test(basename) || /\.sln$/i.test(basename)) {
    if (basename.startsWith(".env")) {
      return "env";
    }
    if (/application\.(ya?ml|properties)$/.test(basename) || /appsettings.*\.json$/i.test(basename)) {
      return "config";
    }
    return "manifest";
  }
  if (SOURCE_EXTENSIONS.has(path.extname(basename))) {
    return "source";
  }
  return null;
}

function isIgnoredPath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => IGNORED_DIRECTORIES.has(segment));
}

function normalizeBaselineExpectation(baseline: TechnicalBaseline | null): DeploymentCodeEvidence["baselineExpectation"] {
  const tracks = recordValue(recordValue(baseline?.stack)?.tracks);
  return {
    web: normalizeTrack(tracks?.web),
    app: normalizeTrack(tracks?.app),
    backend: normalizeTrack(tracks?.backend),
    persistence: normalizeTrack(tracks?.persistence),
    dataAccess: normalizeTrack(tracks?.dataAccess),
    externalServices: normalizeTrack(tracks?.externalServices),
  };
}

function normalizeTrack(value: unknown): DeploymentCodeEvidenceTrack | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const selection = stringValue(record.selection);
  return {
    status: stringValue(record.status),
    selection,
    normalizedSelection: selection ? normalizeTechnologyName(selection) : null,
    source: stringValue(record.source),
    rationale: stringValue(record.rationale),
  };
}

function runtimeFactsFor(stack: DetectedStack, signals: FileSignal[]): DeploymentCodeEvidence["runtimeFacts"] {
  const framework = stack.framework ?? stack.kind;
  const evidenceRefs = signalsForRuntime(stack, signals);
  const backend = ["java", "python", "go", "dotnet", "php", "ruby"].includes(stack.kind) ||
      (stack.kind === "node" && framework && /express|fastify|hono|koa|server|next/.test(framework))
    ? valueEvidence(framework, stack.kind === "unknown" ? "low" : "high", evidenceRefs)
    : null;
  const web = stack.kind === "static" || (stack.kind === "node" && framework && /vite|next|react|vue|svelte|astro/.test(framework))
    ? valueEvidence(framework, "high", evidenceRefs)
    : null;
  return {
    web,
    backend,
    fullstack: web && backend ? valueEvidence(`${web.value}+${backend.value}`, "medium", evidenceRefs) : null,
    workers: [],
  };
}

function buildStartFactsFor(stack: DetectedStack): DeploymentCodeEvidence["buildStartFacts"] {
  const baseEvidence = [evidence("detectedStack", "Derived from current project runtime detection.")];
  return {
    buildCommand: stack.buildCommand ? valueEvidence(stack.buildCommand, "medium", baseEvidence) : null,
    startCommand: stack.startCommand ? valueEvidence(stack.startCommand, "medium", baseEvidence) : null,
    port: valueEvidence(stack.port, "medium", baseEvidence),
    healthPath: stack.healthcheckPath ? valueEvidence(stack.healthcheckPath, "medium", baseEvidence) : null,
    previewPath: valueEvidence("/", "low", baseEvidence),
    frontendOutputDir: stack.outputDirectory ? valueEvidence(stack.outputDirectory, "medium", baseEvidence) : null,
    staticServing: null,
  };
}

function collectServiceCandidates(signals: FileSignal[]): ServiceCandidate[] {
  const candidates: ServiceCandidate[] = [];
  for (const signal of signals) {
    const add = (kind: DependencyServiceKind, reason: string, strength: ServiceCandidate["strength"] = "driver") => {
      candidates.push({
        kind,
        strength,
        evidence: [evidence(signal.file.relativePath, reason)],
      });
    };
    const lower = signal.lower;
    const text = signal.text;

    if (signal.file.relativePath.endsWith("schema.prisma")) {
      const provider = prismaProvider(text);
      if (provider === "postgresql") add("postgres", "Prisma datasource provider is postgresql.", "explicit_provider");
      if (provider === "mysql") add("mysql", "Prisma datasource provider is mysql.", "explicit_provider");
      if (provider === "mongodb") add("mongodb", "Prisma datasource provider is mongodb.", "explicit_provider");
    }

    if (/jdbc:postgresql|postgresql:\/\/|postgres:\/\/|adapter:\s*postgresql|org\.postgresql|gorm\.io\/driver\/postgres|psycopg|asyncpg|npgsql|pdo_pgsql|pgsql/.test(lower) || hasPackageDependency(signal, ["pg"])) {
      add("postgres", "PostgreSQL driver or connection signal found.", dbStrength(signal));
    }
    if (/jdbc:mysql|jdbc:mariadb|mysql:\/\/|mariadb:\/\/|adapter:\s*mysql2?|mysql-connector|mysql2|pymysql|mysqlclient|pdo_mysql|mysqli|gorm\.io\/driver\/mysql/.test(lower)) {
      add("mysql", "MySQL/MariaDB driver or connection signal found.", dbStrength(signal));
    }
    if (/redis:\/\/|redis_url|spring\.data\.redis|spring_redis|ioredis|bullmq|lettuce|jedis|stackexchange\.redis|predis|phpredis|sidekiq|gem\s+["']redis["']/.test(lower) || hasPackageDependency(signal, ["redis"])) {
      add("redis", "Redis driver, queue, or connection signal found.", serviceStrength(signal));
    }
    if (/mongodb:\/\/|mongodb|mongoose|pymongo|motor|mongo-driver|spring-boot-starter-data-mongodb/.test(lower)) {
      add("mongodb", "MongoDB driver or connection signal found.", serviceStrength(signal));
    }
    if (/rabbitmq|amqp:\/\/|rabbitmq_url|spring_rabbit|amqplib|pika/.test(lower)) {
      add("rabbitmq", "RabbitMQ/AMQP driver or connection signal found.", serviceStrength(signal));
    }
    if (/elasticsearch|opensearch|elastic\.clients|@elastic\/elasticsearch/.test(lower)) {
      add("elasticsearch", "Elasticsearch/OpenSearch driver or endpoint signal found.", serviceStrength(signal));
    }
    if (/minio|s3_endpoint|aws_s3_endpoint|s3-compatible/.test(lower)) {
      add("minio", "MinIO/S3-compatible endpoint signal found.", serviceStrength(signal));
    }
  }
  return candidates;
}

function collectEmbeddedStores(signals: FileSignal[]): Array<DeploymentEvidenceValue<"sqlite" | "file">> {
  const stores: Array<DeploymentEvidenceValue<"sqlite" | "file">> = [];
  for (const signal of signals) {
    const lower = signal.lower;
    if (signal.file.relativePath.endsWith("schema.prisma") && prismaProvider(signal.text) === "sqlite") {
      stores.push(valueEvidence("sqlite", "high", [evidence(signal.file.relativePath, "Prisma datasource provider is sqlite.")]));
      continue;
    }
    if (/jdbc:sqlite|sqlite:\/\/|sqlite3|better-sqlite3|microsoft\.data\.sqlite/.test(lower)) {
      stores.push(valueEvidence("sqlite", "high", [evidence(signal.file.relativePath, "SQLite driver or connection signal found.")]));
    }
  }
  return dedupeEvidenceValues(stores);
}

function collectDatabaseRuntimeEvidence(signals: FileSignal[]): DeploymentEvidenceRef[] {
  const refs: DeploymentEvidenceRef[] = [];
  for (const signal of signals) {
    const lower = signal.lower;
    if (/database_url|database_uri|db_url|spring[_\.]datasource|datasource\.url|sqlalchemy_database_uri|connectionstrings|jdbc:/.test(lower)) {
      const matched = databaseRuntimeSignalLabel(lower);
      refs.push(evidence(signal.file.relativePath, `Database runtime configuration or environment reference found${matched ? `: ${matched}` : ""}.`));
    }
  }
  return dedupeRefs(refs);
}

function databaseRuntimeSignalLabel(lower: string): string | null {
  if (/spring[_\.]datasource/.test(lower)) return "SPRING_DATASOURCE";
  if (/database_url/.test(lower)) return "DATABASE_URL";
  if (/database_uri/.test(lower)) return "DATABASE_URI";
  if (/db_url/.test(lower)) return "DB_URL";
  if (/sqlalchemy_database_uri/.test(lower)) return "SQLALCHEMY_DATABASE_URI";
  if (/connectionstrings/.test(lower)) return "ConnectionStrings";
  if (/jdbc:/.test(lower)) return "JDBC";
  return null;
}

function resolveDependencyServices(input: {
  baselineExpectation: DeploymentCodeEvidence["baselineExpectation"];
  serviceCandidates: ServiceCandidate[];
  embeddedStores: Array<DeploymentEvidenceValue<"sqlite" | "file">>;
  databaseRuntimeEvidence: DeploymentEvidenceRef[];
  stack: DetectedStack;
}): {
  services: Array<DeploymentEvidenceValue<DependencyService>>;
  ambiguous: DeploymentCodeEvidence["dependencyFacts"]["ambiguous"];
} {
  const sqliteObserved = input.embeddedStores.some((store) => store.value === "sqlite");
  const grouped = new Map<DependencyServiceKind, ServiceCandidate[]>();
  for (const candidate of input.serviceCandidates) {
    if (sqliteObserved && isPackageOnlySqlDriver(candidate)) {
      continue;
    }
    const current = grouped.get(candidate.kind) ?? [];
    current.push(candidate);
    grouped.set(candidate.kind, current);
  }

  const baselineKind = baselinePersistenceServiceKind(input.baselineExpectation.persistence);
  const groupedDatabaseKinds = [...grouped.keys()].filter((kind) => DATABASE_SERVICE_KINDS.has(kind));
  if (input.databaseRuntimeEvidence.length > 0 && baselineKind && !grouped.has(baselineKind) && groupedDatabaseKinds.length === 0) {
    grouped.set(baselineKind, [{
      kind: baselineKind,
      strength: "runtime_config",
      evidence: [
        ...input.databaseRuntimeEvidence,
        evidence("TechnicalBaseline", `Database runtime signal uses baseline persistence ${input.baselineExpectation.persistence?.selection}.`),
      ],
    }]);
  }

  const services = [...grouped.entries()]
    .map(([kind, candidates]) => {
      const refs = dedupeRefs([
        ...candidates.flatMap((candidate) => candidate.evidence),
        ...(DATABASE_SERVICE_KINDS.has(kind) ? input.databaseRuntimeEvidence : []),
      ]);
      const service = serviceWithRuntimeConnectionEnv(
        serviceDefinition(kind, refs.map((ref) => `${ref.path}: ${ref.reason}`).join(" ")),
        input.stack,
        refs,
      );
      return valueEvidence(service, serviceConfidence(candidates), refs);
    })
    .sort((left, right) => left.value.kind.localeCompare(right.value.kind));

  const hasDatabaseService = services.some((service) => DATABASE_SERVICE_KINDS.has(service.value.kind));
  const ambiguous = input.databaseRuntimeEvidence.length > 0 && !hasDatabaseService && !sqliteObserved
    ? [{
        kind: "database" as const,
        reason: "Code references a database runtime binding, but no database kind was identified from code evidence or TechnicalBaseline.",
        evidence: input.databaseRuntimeEvidence,
      }]
    : [];

  return { services, ambiguous };
}

function conflictFacts(
  baselineExpectation: DeploymentCodeEvidence["baselineExpectation"],
  services: Array<DeploymentEvidenceValue<DependencyService>>,
  embeddedStores: Array<DeploymentEvidenceValue<"sqlite" | "file">>,
): DeployConflict[] {
  const conflicts: DeployConflict[] = [];
  const baselineKind = baselinePersistenceKind(baselineExpectation.persistence);
  const codeDatabaseKinds = [
    ...services
      .map((service) => service.value.kind)
      .filter((kind) => DATABASE_SERVICE_KINDS.has(kind)),
    ...embeddedStores.map((store) => store.value),
  ];
  if (!baselineKind || codeDatabaseKinds.length === 0) {
    return conflicts;
  }
  const normalizedCodeKinds = new Set(codeDatabaseKinds.map((kind) => kind === "file" ? "file" : kind));
  if (!normalizedCodeKinds.has(baselineKind)) {
    const firstService = services.find((service) => DATABASE_SERVICE_KINDS.has(service.value.kind));
    const firstEmbedded = embeddedStores[0];
    conflicts.push({
      conflictId: "baseline-persistence-code-conflict",
      type: "technical_baseline_code_conflict",
      message: `TechnicalBaseline persistence is ${baselineExpectation.persistence?.selection}, but repository evidence indicates ${[...normalizedCodeKinds].join(", ")}.`,
      left: evidence("TechnicalBaseline", `persistence=${baselineExpectation.persistence?.selection ?? "unknown"}`),
      right: firstService?.evidence[0] ?? firstEmbedded?.evidence[0] ?? evidence("repository", "Database evidence found."),
      resolution: "ask_user",
    });
  }
  return conflicts;
}

function missingFactsFor(input: {
  baselineExpectation: DeploymentCodeEvidence["baselineExpectation"];
  dependencyServices: {
    services: Array<DeploymentEvidenceValue<DependencyService>>;
    ambiguous: DeploymentCodeEvidence["dependencyFacts"]["ambiguous"];
  };
  databaseRuntimeEvidence: DeploymentEvidenceRef[];
}): DeployMissingFact[] {
  if (input.dependencyServices.ambiguous.length === 0) {
    return [];
  }
  return [{
    factId: "database-kind-required",
    type: "database_kind",
    message: "Repository code references a database runtime binding, but deploy cannot determine the database kind.",
    evidence: input.databaseRuntimeEvidence,
    resolution: "execution_repair",
  }];
}

function warningsFor(
  baselineExpectation: DeploymentCodeEvidence["baselineExpectation"],
  services: Array<DeploymentEvidenceValue<DependencyService>>,
  embeddedStores: Array<DeploymentEvidenceValue<"sqlite" | "file">>,
): string[] {
  const warnings: string[] = [];
  const baselineKind = baselinePersistenceKind(baselineExpectation.persistence);
  const codeHasDatabase = services.some((service) => DATABASE_SERVICE_KINDS.has(service.value.kind)) || embeddedStores.length > 0;
  if (baselineKind && !codeHasDatabase) {
    warnings.push(`TechnicalBaseline expects ${baselineExpectation.persistence?.selection}, but current code evidence does not show an implemented database dependency. Deploy will not start that service from baseline alone.`);
  }
  return warnings;
}

function serviceWithRuntimeConnectionEnv(
  service: DependencyService,
  stack: DetectedStack,
  refs: DeploymentEvidenceRef[],
): DependencyService {
  const combined = refs.map((ref) => `${ref.path} ${ref.reason}`).join("\n").toLowerCase();
  const springLike = /spring[_\.]datasource/.test(combined) ||
    (stack.kind === "java" && (stack.framework === "spring-boot" || /application\.ya?ml|application\.properties/.test(combined)));
  if (!springLike) {
    return service;
  }
  if (service.kind === "postgres") {
    return {
      ...service,
      connectionEnv: {
        ...service.connectionEnv,
        SPRING_DATASOURCE_URL: "jdbc:postgresql://postgres:5432/loom",
        SPRING_DATASOURCE_USERNAME: "loom",
        SPRING_DATASOURCE_PASSWORD: "loom",
      },
    };
  }
  if (service.kind === "mysql") {
    return {
      ...service,
      connectionEnv: {
        ...service.connectionEnv,
        SPRING_DATASOURCE_URL: "jdbc:mysql://mysql:3306/loom",
        SPRING_DATASOURCE_USERNAME: "loom",
        SPRING_DATASOURCE_PASSWORD: "loom",
      },
    };
  }
  return service;
}

function serviceConfidence(candidates: ServiceCandidate[]): DeploymentEvidenceConfidence {
  if (candidates.some((candidate) => candidate.strength === "explicit_provider" || candidate.strength === "runtime_config" || candidate.strength === "env")) {
    return "high";
  }
  return candidates.length > 1 ? "high" : "medium";
}

function dbStrength(signal: FileSignal): ServiceCandidate["strength"] {
  return signal.file.kind === "manifest" ? "driver" : "runtime_config";
}

function serviceStrength(signal: FileSignal): ServiceCandidate["strength"] {
  return signal.file.kind === "env" || signal.file.kind === "config" ? "env" : "driver";
}

function isPackageOnlySqlDriver(candidate: ServiceCandidate): boolean {
  return candidate.strength === "driver" &&
    candidate.evidence.every((ref) => /package\.json$|pom\.xml$|build\.gradle|requirements\.txt$|pyproject\.toml$|go\.mod$|\.csproj$|composer\.json$|Gemfile$/.test(ref.path));
}

function baselinePersistenceKind(track: DeploymentCodeEvidenceTrack | null): DependencyServiceKind | "sqlite" | "file" | null {
  const value = track?.normalizedSelection ?? "";
  if ((track && /not_needed|not_applicable/i.test(track.status ?? "")) || /no persistence|不需要|none|not needed/.test(value)) {
    return null;
  }
  if (/postgres|postgresql|pgsql/.test(value)) return "postgres";
  if (/mysql|mariadb/.test(value)) return "mysql";
  if (/mongodb|mongo/.test(value)) return "mongodb";
  if (/sqlite/.test(value)) return "sqlite";
  if (/file|json/.test(value)) return "file";
  return null;
}

function baselinePersistenceServiceKind(track: DeploymentCodeEvidenceTrack | null): DependencyServiceKind | null {
  const kind = baselinePersistenceKind(track);
  return kind === "postgres" || kind === "mysql" || kind === "mongodb" ? kind : null;
}

function signalsForRuntime(stack: DetectedStack, signals: FileSignal[]): DeploymentEvidenceRef[] {
  const refs = signals
    .filter((signal) => {
      const lower = signal.lower;
      if (stack.kind === "java") return /spring-boot|pom\.xml|build\.gradle|application\.properties|application\.ya?ml/.test(lower) || /pom\.xml|build\.gradle|application\./.test(signal.file.relativePath);
      if (stack.kind === "node") return /package\.json$/.test(signal.file.relativePath);
      if (stack.kind === "python") return /pyproject\.toml|requirements\.txt|fastapi|django|flask/.test(signal.file.relativePath) || /fastapi|django|flask/.test(lower);
      if (stack.kind === "go") return /go\.mod$/.test(signal.file.relativePath);
      if (stack.kind === "dotnet") return /\.csproj$|\.sln$|appsettings/.test(signal.file.relativePath);
      return false;
    })
    .slice(0, 5)
    .map((signal) => evidence(signal.file.relativePath, "Runtime declaration signal."));
  return refs.length > 0 ? refs : [evidence("detectedStack", "Derived from current project runtime detection.")];
}

function hasPackageDependency(signal: FileSignal, names: string[]): boolean {
  if (!signal.file.relativePath.endsWith("package.json")) {
    return false;
  }
  try {
    const pkg = JSON.parse(signal.text) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
    };
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
    };
    return names.some((name) => Object.prototype.hasOwnProperty.call(deps, name));
  } catch {
    return false;
  }
}

function prismaProvider(text: string): string | null {
  const match = text.match(/provider\s*=\s*"([^"]+)"/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function evidence(pathValue: string, reason: string): DeploymentEvidenceRef {
  return { path: pathValue, reason };
}

function valueEvidence<T>(
  value: T,
  confidence: DeploymentEvidenceConfidence,
  refs: DeploymentEvidenceRef[],
): DeploymentEvidenceValue<T> {
  return {
    value,
    confidence,
    evidence: dedupeRefs(refs),
  };
}

function dedupeEvidenceValues<T extends string>(values: Array<DeploymentEvidenceValue<T>>): Array<DeploymentEvidenceValue<T>> {
  const seen = new Set<T>();
  const output: Array<DeploymentEvidenceValue<T>> = [];
  for (const value of values) {
    if (seen.has(value.value)) {
      continue;
    }
    seen.add(value.value);
    output.push(value);
  }
  return output;
}

function dedupeRefs(refs: DeploymentEvidenceRef[]): DeploymentEvidenceRef[] {
  const seen = new Set<string>();
  const output: DeploymentEvidenceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.path}\0${ref.reason}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(ref);
  }
  return output;
}

function fingerprintEvidence(value: Omit<DeploymentCodeEvidence, "fingerprint">): string {
  const stable = JSON.stringify({
    technicalBaselineRef: value.technicalBaselineRef,
    baselineExpectation: value.baselineExpectation,
    runtimeFacts: compactEvidenceValues(value.runtimeFacts),
    buildStartFacts: compactEvidenceValues(value.buildStartFacts),
    dependencyFacts: value.dependencyFacts,
    environmentFacts: value.environmentFacts,
    existingDeployAssets: value.existingDeployAssets,
    conflicts: value.conflicts,
    missingFacts: value.missingFacts,
    warnings: value.warnings,
  });
  return createHash("sha256").update(stable).digest("hex");
}

function compactEvidenceValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compactEvidenceValues);
  }
  if (!recordValue(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if ("value" in record && "confidence" in record) {
    return {
      value: record.value,
      confidence: record.confidence,
      evidence: record.evidence,
    };
  }
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, compactEvidenceValues(entry)]));
}

function normalizeTechnologyName(value: string): string {
  return value.toLowerCase().replace(/\s*\+\s*/g, "+").trim();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right);
}
