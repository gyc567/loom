import path from "node:path";
import type {
  DeploymentBootstrapDiagnostics,
  DeploymentComposeInfo,
  DeployProvider,
  DeploymentProviderPolicy,
  DeploymentEnvDiagnostics,
  DeploymentProviderCandidate,
  DeploymentWorkspace,
  DetectedStack,
  DeploymentSpec,
} from "./types";
import { toProjectRelative } from "../state/paths";
import { generatedDependencyEnvironment, generatedRuntimeEnvironment } from "./env";

export type GeneratedDeploymentFiles = {
  dockerfile: string;
  compose: string;
  dockerignore: string;
};

export function createDeploymentSpec(input: {
  projectRoot: string;
  deploymentRoot: string;
  buildContextRoot: string;
  workspace: DeploymentWorkspace;
  provider: DeployProvider;
  providerReason: string;
  providerPolicy: DeploymentProviderPolicy;
  providerCandidates: DeploymentProviderCandidate[];
  detectedStack: DetectedStack;
  environment: DeploymentEnvDiagnostics;
  bootstrap: DeploymentBootstrapDiagnostics;
  compose?: DeploymentComposeInfo;
  dockerfilePath: string;
  composePath: string;
  dockerignorePath: string;
  generated: boolean;
  reused: string[];
  hostPort: number;
}): DeploymentSpec {
  const serviceName = sanitizeName(path.basename(input.deploymentRoot));
  const imageName = `${serviceName}:loom-local`;
  const composePath = toProjectRelative(input.projectRoot, input.composePath);
  const dockerfilePath = toProjectRelative(input.projectRoot, input.dockerfilePath);
  const buildContextPath = toProjectRelative(input.projectRoot, input.buildContextRoot) || ".";
  const healthcheckPath = input.detectedStack.healthcheckPath ?? "/";
  const healthcheckEnabled = input.detectedStack.startCommand !== null || input.provider === "dockerfile-template";
  const baseUrl = `http://localhost:${input.hostPort}`;

  return {
    schemaVersion: 1,
    provider: input.provider,
    providerReason: input.providerReason,
    providerPolicy: input.providerPolicy,
    providerCandidates: input.providerCandidates,
    serviceName,
    imageName,
    projectRoot: input.projectRoot,
    generatedAt: new Date().toISOString(),
    workspace: input.workspace,
    detectedStack: input.detectedStack,
    environment: input.environment,
    bootstrap: input.bootstrap,
    compose: input.compose ?? generatedComposeInfo(serviceName, input.detectedStack.port),
    runtimeContract: {
      source: "heuristic",
      ref: null,
      status: "heuristic",
      dependencyServicePolicy: "heuristic",
      runtimeKind: input.detectedStack.framework ?? input.detectedStack.kind,
      buildCommand: input.detectedStack.buildCommand,
      startCommand: input.detectedStack.startCommand,
      port: input.detectedStack.port,
      previewPath: "/",
      healthPath: input.detectedStack.healthcheckPath ?? null,
      apiPaths: [],
      frontendOutputDir: input.detectedStack.outputDirectory,
      probeKind: input.detectedStack.startCommand ? "http" : "process",
      environment: {
        required: [],
        optional: [],
      },
      dependencyServices: [],
    },
    files: {
      dockerfilePath,
      composePath,
      dockerignorePath: toProjectRelative(input.projectRoot, input.dockerignorePath),
      buildContextPath,
      generated: input.generated,
      reused: input.reused,
    },
    runtime: {
      containerPort: input.detectedStack.port,
      hostPort: input.hostPort,
      url: `http://localhost:${input.hostPort}`,
      healthcheck: {
        enabled: healthcheckEnabled,
        path: healthcheckPath,
        candidates: healthcheckCandidatesFor(input.detectedStack),
        url: healthcheckEnabled ? `${baseUrl}${healthcheckPath}` : null,
        expectedStatusMax: 399,
        attempts: 12,
        intervalMs: 1_000,
        timeoutMs: 2_000,
      },
    },
    commands: {
      build: ["docker", "compose", "-f", composePath, "build"],
      up: ["docker", "compose", "-f", composePath, "up", "-d", "--build"],
      down: ["docker", "compose", "-f", composePath, "down"],
      logs: ["docker", "compose", "-f", composePath, "logs", "--tail", "120"],
      status: ["docker", "compose", "-f", composePath, "ps"],
    },
  };
}

function generatedComposeInfo(serviceName: string, containerPort: number): DeploymentComposeInfo {
  return {
    selectedService: serviceName,
    serviceReason: "Generated Compose uses the generated application service.",
    services: [
      {
        name: serviceName,
        score: 100,
        image: null,
        build: true,
        ports: [
          {
            hostPort: null,
            containerPort,
            protocol: "tcp",
            raw: String(containerPort),
          },
        ],
        expose: [],
        dependsOn: [],
        profiles: [],
        dependencyLike: false,
        reason: "Generated application service.",
      },
    ],
    warnings: [],
  };
}

export function generateDeploymentFiles(spec: DeploymentSpec): GeneratedDeploymentFiles {
  if (!spec.files.dockerfilePath) {
    throw new Error("Cannot generate Dockerfile deployment files without a Dockerfile path.");
  }

  return {
    dockerfile: generateDockerfile(spec.detectedStack),
    compose: generateCompose(spec, spec.files.dockerfilePath),
    dockerignore: generateDockerignore(),
  };
}

function healthcheckCandidatesFor(stack: DetectedStack): string[] {
  const common = ["/", "/health", "/healthz", "/api/health", "/ready", "/readiness"];
  const detected = stack.healthcheckPath ? [stack.healthcheckPath] : [];
  switch (stack.framework) {
    case "fastapi":
    case "flask":
    case "django":
    case "stdlib-http":
      return dedupeStrings([...detected, "/health", "/healthz", "/ready", "/", ...common]);
    case "spring-boot":
      return dedupeStrings([...detected, "/actuator/health", "/health", "/ready", "/", ...common]);
    case "laravel":
    case "rails":
      return dedupeStrings([...detected, "/up", "/health", "/", ...common]);
    case "next":
      return dedupeStrings([...detected, "/api/health", "/health", "/", ...common]);
    default:
      return dedupeStrings([...detected, ...common]);
  }
}

function generateDockerfile(stack: DetectedStack): string {
  if (stack.kind === "static") {
    return [
      "FROM nginx:1.27-alpine",
      "WORKDIR /usr/share/nginx/html",
      "COPY . .",
      "EXPOSE 80",
      "",
    ].join("\n");
  }

  if (stack.kind === "node") {
    return generateNodeDockerfile(stack);
  }

  if (stack.kind === "python") {
    return generatePythonDockerfile(stack);
  }

  if (stack.kind === "go") {
    return generateGoDockerfile(stack);
  }

  if (stack.kind === "java") {
    return generateJavaDockerfile(stack);
  }

  if (stack.kind === "dotnet") {
    return generateDotnetDockerfile(stack);
  }

  if (stack.kind === "php") {
    return generatePhpDockerfile(stack);
  }

  if (stack.kind === "ruby") {
    return generateRubyDockerfile(stack);
  }

  return [
    "FROM alpine:3.20",
    "WORKDIR /app",
    "COPY . .",
    "CMD [\"sh\", \"-c\", \"echo 'loom could not detect a runnable stack for this project.' && exit 64\"]",
    "",
  ].join("\n");
}

function generateNodeDockerfile(stack: DetectedStack): string {
  const installCommand = installCommandFor(stack.packageManager ?? "npm", stack.hasLockfile);
  const lockfileCopy = lockfileCopyFor(stack.packageManager ?? "npm");
  const baseImage = nodeBaseImageFor(stack);
  const buildLines = stack.buildCommand ? [`RUN ${stack.buildCommand}`] : [];
  const startCommand = stack.startCommand ?? "echo 'loom cannot start this Node project because no start script was detected.' && exit 64";

  return [
    `FROM ${baseImage} AS deps`,
    "WORKDIR /app",
    lockfileCopy,
    ...workspaceManifestCopyLines(stack),
    `RUN ${installCommand}`,
    "RUN mkdir -p node_modules",
    "",
    `FROM ${baseImage} AS runner`,
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    "ENV NEXT_TELEMETRY_DISABLED=1",
    "COPY --from=deps /app/package*.json ./",
    "COPY --from=deps /app/node_modules ./node_modules",
    ...workspaceManifestCopyLines(stack, "--from=deps /app"),
    ...workspaceNodeModulesCopyLines(stack),
    "COPY . .",
    ...workingDirectoryLines(stack),
    ...buildLines,
    `EXPOSE ${stack.port}`,
    `CMD ${JSON.stringify(["sh", "-c", startCommand])}`,
    "",
  ].join("\n");
}

function generatePythonDockerfile(stack: DetectedStack): string {
  const installLines = pythonInstallLines(stack.packageManager ?? "pip");
  const startCommand =
    stack.startCommand ??
    "echo 'loom cannot start this Python project because no runnable web command was detected.' && exit 64";

  return [
    "FROM python:3.12-slim AS runner",
    "WORKDIR /app",
    "ENV PYTHONDONTWRITEBYTECODE=1",
    "ENV PYTHONUNBUFFERED=1",
    `ENV PORT=${stack.port}`,
    ...installLines,
    "COPY . .",
    `EXPOSE ${stack.port}`,
    `CMD ${JSON.stringify(["sh", "-c", startCommand])}`,
    "",
  ].join("\n");
}

function generateGoDockerfile(stack: DetectedStack): string {
  const startCommand = stack.startCommand ?? "/app/server";

  return [
    "FROM golang:1.23-alpine AS builder",
    "WORKDIR /src",
    "COPY go.mod go.sum* ./",
    "RUN go mod download",
    "COPY . .",
    "RUN CGO_ENABLED=0 GOOS=linux go build -o /out/server .",
    "",
    "FROM alpine:3.20 AS runner",
    "WORKDIR /app",
    "RUN adduser -D -H appuser",
    "COPY --from=builder /out/server /app/server",
    "USER appuser",
    `EXPOSE ${stack.port}`,
    `CMD ${JSON.stringify(["sh", "-c", startCommand])}`,
    "",
  ].join("\n");
}

function generateJavaDockerfile(stack: DetectedStack): string {
  const javaVersion = stack.runtimeVersion ?? "21";
  const packageManager = stack.packageManager === "gradle" ? "gradle" : "maven";
  const builderImage = packageManager === "maven"
    ? `maven:3-eclipse-temurin-${javaVersion}`
    : `gradle:8-jdk${javaVersion}`;
  const artifactDirectory = packageManager === "maven" ? "target" : "build/libs";
  const buildCommand = stack.buildCommand ?? javaBuildCommand(packageManager);
  const startCommand = stack.startCommand ?? "java -jar /app/app.jar";

  return [
    `FROM ${builderImage} AS builder`,
    "WORKDIR /workspace",
    "COPY . .",
    `RUN ${buildCommand}`,
    `RUN JAR=\"$(find ${artifactDirectory} -maxdepth 1 -type f -name '*.jar' ! -name '*-plain.jar' ! -name '*sources.jar' ! -name '*javadoc.jar' | head -n 1)\" && test -n \"$JAR\" && cp \"$JAR\" /workspace/app.jar`,
    "",
    `FROM eclipse-temurin:${javaVersion}-jre AS runner`,
    "WORKDIR /app",
    `ENV PORT=${stack.port}`,
    `ENV SERVER_PORT=${stack.port}`,
    "COPY --from=builder /workspace/app.jar /app/app.jar",
    `EXPOSE ${stack.port}`,
    `CMD ${JSON.stringify(["sh", "-c", startCommand])}`,
    "",
  ].join("\n");
}

function generateDotnetDockerfile(stack: DetectedStack): string {
  const dotnetVersion = stack.runtimeVersion ?? "8";
  const runtimeImage = stack.framework === "aspnetcore"
    ? `mcr.microsoft.com/dotnet/aspnet:${dotnetVersion}`
    : `mcr.microsoft.com/dotnet/runtime:${dotnetVersion}`;
  const startCommand = stack.startCommand ?? "dotnet /app/app.dll";

  return [
    `FROM mcr.microsoft.com/dotnet/sdk:${dotnetVersion} AS build`,
    "WORKDIR /src",
    "COPY . .",
    "RUN dotnet restore",
    "RUN dotnet publish -c Release -o /app/publish --no-restore",
    "",
    `FROM ${runtimeImage} AS runner`,
    "WORKDIR /app",
    `ENV ASPNETCORE_URLS=http://0.0.0.0:${stack.port}`,
    `ENV PORT=${stack.port}`,
    "COPY --from=build /app/publish .",
    `EXPOSE ${stack.port}`,
    `CMD ${JSON.stringify(["sh", "-c", startCommand])}`,
    "",
  ].join("\n");
}

function generatePhpDockerfile(stack: DetectedStack): string {
  const phpVersion = stack.runtimeVersion ?? "8.3";
  const startCommand = stack.startCommand ?? "php -S 0.0.0.0:${PORT:-8000} -t public public/index.php";

  return [
    `FROM php:${phpVersion}-cli AS runner`,
    "WORKDIR /app",
    "RUN apt-get update && apt-get install -y --no-install-recommends \\",
    "    git unzip libpq-dev libzip-dev \\",
    "  && docker-php-ext-install pdo pdo_mysql pdo_pgsql zip \\",
    "  && rm -rf /var/lib/apt/lists/*",
    "COPY --from=composer:2 /usr/bin/composer /usr/bin/composer",
    "COPY composer.json composer.lock* ./",
    "RUN composer install --no-dev --prefer-dist --no-interaction --optimize-autoloader --no-scripts",
    "COPY . .",
    ...(stack.framework === "laravel"
      ? [
          "RUN mkdir -p storage bootstrap/cache && chmod -R 775 storage bootstrap/cache",
          "RUN php artisan package:discover --ansi || true",
        ]
      : []),
    `ENV PORT=${stack.port}`,
    `EXPOSE ${stack.port}`,
    `CMD ${JSON.stringify(["sh", "-c", startCommand])}`,
    "",
  ].join("\n");
}

function generateRubyDockerfile(stack: DetectedStack): string {
  const rubyVersion = stack.runtimeVersion ?? "3.3";
  const startCommand = stack.startCommand ?? "bundle exec rails server -b 0.0.0.0 -p ${PORT:-3000}";

  return [
    `FROM ruby:${rubyVersion}-slim AS runner`,
    "WORKDIR /app",
    "RUN apt-get update && apt-get install -y --no-install-recommends \\",
    "    build-essential git libpq-dev pkg-config \\",
    "  && rm -rf /var/lib/apt/lists/*",
    "COPY Gemfile Gemfile.lock* ./",
    "RUN bundle config set without 'development test' && bundle install",
    "COPY . .",
    ...(stack.framework === "rails"
      ? [
          "RUN mkdir -p tmp/pids tmp/cache log storage",
        ]
      : []),
    `ENV RAILS_ENV=production`,
    `ENV RACK_ENV=production`,
    `ENV PORT=${stack.port}`,
    `EXPOSE ${stack.port}`,
    `CMD ${JSON.stringify(["sh", "-c", startCommand])}`,
    "",
  ].join("\n");
}

export function generateComposeForDockerfile(spec: DeploymentSpec): string {
  if (!spec.files.dockerfilePath) {
    throw new Error("Cannot generate Compose file without a Dockerfile path.");
  }
  return generateCompose(spec, spec.files.dockerfilePath);
}

function generateCompose(spec: DeploymentSpec, dockerfilePath: string): string {
  const service = spec.serviceName;
  const port = `${spec.runtime.hostPort}:${spec.runtime.containerPort}`;
  const contextPath = projectPathRelativeToFile(spec.files.composePath, spec.files.buildContextPath);
  const dockerfile = projectPathRelativeToDirectory(spec.files.buildContextPath, dockerfilePath);
  const appEnvironment = {
    ...generatedRuntimeEnvironment(spec.detectedStack),
    ...generatedDependencyEnvironment(spec.detectedStack),
    ...spec.environment.generated,
  };

  const lines = [
    "services:",
    `  ${service}:`,
    "    build:",
    `      context: ${yamlString(contextPath)}`,
    `      dockerfile: ${yamlString(dockerfile)}`,
    `    image: ${spec.imageName}`,
    `    container_name: loom-${service}`,
    "    ports:",
    `      - \"${port}\"`,
    ...yamlEnvironment(appEnvironment, 4),
    ...(spec.detectedStack.startCommand
      ? [
          "    healthcheck:",
          `      test: [\"CMD-SHELL\", \"wget -qO- http://127.0.0.1:${spec.runtime.containerPort}${spec.runtime.healthcheck.path} >/dev/null 2>&1 || exit 1\"]`,
          "      interval: 10s",
          "      timeout: 3s",
          "      retries: 6",
          "      start_period: 10s",
        ]
      : []),
    ...(spec.detectedStack.services.length > 0
      ? [
          "    depends_on:",
          ...spec.detectedStack.services.map((dependency) => `      - ${dependency.serviceName}`),
        ]
      : []),
    "    restart: unless-stopped",
    "",
    ...spec.detectedStack.services.flatMap(generateDependencyService),
    ...generateVolumes(spec),
  ];

  return lines.join("\n");
}

function generateDependencyService(service: DetectedStack["services"][number]): string[] {
  const commandLines = dependencyCommand(service);

  return [
    `  ${service.serviceName}:`,
    `    image: ${service.image}`,
    ...commandLines,
    ...(Object.keys(service.env).length > 0 ? yamlEnvironment(service.env, 4) : []),
    "    expose:",
    `      - \"${service.port}\"`,
    ...(service.volumeName
      ? [
          "    volumes:",
          `      - ${service.volumeName}:${service.volumeTarget ?? "/data"}`,
        ]
      : []),
    "",
  ];
}

function generateVolumes(spec: DeploymentSpec): string[] {
  const volumes = spec.detectedStack.services
    .map((service) => service.volumeName)
    .filter((volumeName): volumeName is string => Boolean(volumeName));
  if (volumes.length === 0) {
    return [];
  }

  return [
    "volumes:",
    ...volumes.map((volumeName) => `  ${volumeName}:`),
    "",
  ];
}

function yamlMap(values: Record<string, string>, indent: number): string[] {
  const prefix = " ".repeat(indent);
  return Object.entries(values).map(([key, value]) => `${prefix}${key}: ${JSON.stringify(value)}`);
}

function yamlEnvironment(values: Record<string, string>, indent: number): string[] {
  const prefix = " ".repeat(indent);
  if (Object.keys(values).length === 0) {
    return [`${prefix}environment: {}`];
  }
  return [
    `${prefix}environment:`,
    ...yamlMap(values, indent + 2),
  ];
}

function projectPathRelativeToFile(fromProjectRelativeFile: string, toProjectRelativePath: string): string {
  const fromDirectory = path.dirname(fromProjectRelativeFile);
  return projectPathRelativeToDirectory(fromDirectory, toProjectRelativePath);
}

function projectPathRelativeToDirectory(fromProjectRelativeDirectory: string, toProjectRelativePath: string): string {
  const relative = path.relative(fromProjectRelativeDirectory, toProjectRelativePath).split(path.sep).join("/");
  return relative || ".";
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function generateDockerignore(): string {
  return [
    ".git",
    ".loom/deployment/specs/local.json",
    ".loom/deployment/specs/generated/compose.yaml",
    ".loom/deployment/state",
    ".loom/deployment/logs",
    ".loom/tmp",
    "node_modules",
    ".next",
    ".turbo",
    ".vercel",
    "out",
    "dist",
    "build",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "*.pyc",
    "target",
    "tmp",
    "coverage",
    "*.log",
    ".env",
    ".env.*",
    "!.env.example",
    "",
  ].join("\n");
}

function installCommandFor(
  packageManager: NonNullable<DetectedStack["packageManager"]>,
  hasLockfile: boolean,
): string {
  switch (packageManager) {
    case "npm":
      return hasLockfile ? "npm ci" : "npm install";
    case "pnpm":
      return hasLockfile
        ? "corepack enable && pnpm install --frozen-lockfile"
        : "corepack enable && pnpm install";
    case "yarn":
      return hasLockfile
        ? "corepack enable && yarn install --frozen-lockfile"
        : "corepack enable && yarn install";
    case "bun":
      return hasLockfile
        ? "bun install --frozen-lockfile"
        : "bun install";
    case "pip":
    case "poetry":
    case "uv":
    case "go":
    case "maven":
    case "gradle":
    case "dotnet":
    case "composer":
    case "bundler":
      return "";
  }
}

function nodeBaseImageFor(stack: DetectedStack): string {
  if (stack.packageManager === "bun") {
    return "oven/bun:1";
  }

  return `node:${stack.runtimeVersion ?? "22"}-slim`;
}

function lockfileCopyFor(packageManager: NonNullable<DetectedStack["packageManager"]>): string {
  switch (packageManager) {
    case "npm":
      return "COPY package.json package-lock.json* ./";
    case "pnpm":
      return "COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./";
    case "yarn":
      return "COPY package.json yarn.lock* ./";
    case "bun":
      return "COPY package.json bun.lock* bun.lockb* ./";
    case "pip":
    case "poetry":
    case "uv":
    case "go":
    case "maven":
    case "gradle":
    case "dotnet":
    case "composer":
    case "bundler":
      return "COPY . ./";
  }
}

function workingDirectoryLines(stack: DetectedStack): string[] {
  return stack.workingDirectory ? [`WORKDIR /app/${stack.workingDirectory}`] : [];
}

function workspaceManifestCopyLines(stack: DetectedStack, sourcePrefix = "."): string[] {
  if (stack.kind !== "node") {
    return [];
  }

  const manifestPaths = new Set<string>();
  if (stack.workingDirectory) {
    manifestPaths.add(`${stack.workingDirectory}/package.json`);
  }
  for (const manifestPath of stack.workspacePackageJsonPaths ?? []) {
    manifestPaths.add(manifestPath);
  }

  return [...manifestPaths]
    .sort(comparePaths)
    .map((manifestPath) => {
      const source = sourcePrefix === "." ? manifestPath : `${sourcePrefix}/${manifestPath}`;
      return `COPY ${source} ./${manifestPath}`;
    });
}

function workspaceNodeModulesCopyLines(stack: DetectedStack): string[] {
  if (!stack.workingDirectory || stack.kind !== "node") {
    return [];
  }
  if (!["pnpm", "yarn"].includes(stack.packageManager ?? "")) {
    return [];
  }

  return [
    `COPY --from=deps /app/${stack.workingDirectory}/node_modules ./${stack.workingDirectory}/node_modules`,
  ];
}

function javaBuildCommand(packageManager: "maven" | "gradle"): string {
  return packageManager === "maven"
    ? "if [ -x ./mvnw ]; then ./mvnw -DskipTests package; else mvn -DskipTests package; fi"
    : "if [ -x ./gradlew ]; then ./gradlew build -x test; else gradle build -x test; fi";
}

function pythonInstallLines(packageManager: NonNullable<DetectedStack["packageManager"]>): string[] {
  switch (packageManager) {
    case "uv":
      return [
        "RUN pip install --no-cache-dir uv",
        "COPY pyproject.toml uv.lock* requirements.txt* ./",
        "RUN if [ -f uv.lock ] || [ -f pyproject.toml ]; then uv pip install --system -r pyproject.toml || uv pip install --system -r requirements.txt; elif [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi",
      ];
    case "poetry":
      return [
        "RUN pip install --no-cache-dir poetry",
        "COPY pyproject.toml poetry.lock* requirements.txt* ./",
        "RUN if [ -f pyproject.toml ]; then poetry config virtualenvs.create false && poetry install --only main --no-interaction --no-ansi; elif [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi",
      ];
    case "pip":
    default:
      return [
        "COPY requirements.txt pyproject.toml* ./",
        "RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi",
      ];
  }
}

function dependencyCommand(service: DetectedStack["services"][number]): string[] {
  if (service.kind === "minio") {
    return ["    command: server /data --console-address \":9001\""];
  }
  return [];
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right);
}

function sanitizeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "app";
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}
