import type { ArchitectureArtifactContract } from "../contracts";
import type { DeploymentRuntimeContract, DetectedStack } from "./types";
import { serviceDefinition } from "./detect";

export function deploymentRuntimeContractFromAac(
  aac: ArchitectureArtifactContract | null,
  fallbackStack: DetectedStack,
  ref: string | null,
): DeploymentRuntimeContract {
  const runtime = aac?.runtimeDelivery;
  if (!runtime || runtime.status === "not_applicable") {
    return heuristicRuntimeContract(fallbackStack, ref);
  }
  if (runtime.status === "unchanged") {
    return {
      ...heuristicRuntimeContract(fallbackStack, runtime.basis.previousRuntimeDeliveryRef ?? ref),
      source: "previous_accepted_aac",
      status: "unchanged",
      runtimeKind: runtime.runtimeKind,
    };
  }
  return {
    source: "accepted_aac",
    ref,
    status: runtime.status,
    dependencyServicePolicy: "contract_only",
    runtimeKind: runtime.runtimeKind,
    buildCommand: runtime.build?.command ?? null,
    startCommand: runtime.start?.command ?? null,
    port: runtime.start?.port ?? null,
    previewPath: runtime.httpProbes?.previewPath ?? "/",
    healthPath: runtime.httpProbes?.healthPath ?? null,
    apiPaths: runtime.httpProbes?.apiPaths ?? [],
    frontendOutputDir: runtime.frontend?.outputDir ?? null,
    probeKind: runtimeProbeKind(runtime),
    environment: {
      required: [...(runtime.environment?.required ?? [])],
      optional: [...(runtime.environment?.optional ?? [])],
    },
    dependencyServices: contractDependencyServices(runtime),
  };
}

export function heuristicRuntimeContract(stack: DetectedStack, ref: string | null = null): DeploymentRuntimeContract {
  return {
    source: "heuristic",
    ref,
    status: "heuristic",
    dependencyServicePolicy: "heuristic",
    runtimeKind: stack.framework ?? stack.kind,
    buildCommand: stack.buildCommand,
    startCommand: stack.startCommand,
    port: stack.port,
    previewPath: "/",
    healthPath: stack.healthcheckPath ?? null,
    apiPaths: [],
    frontendOutputDir: stack.outputDirectory,
    probeKind: stack.startCommand ? "http" : "process",
    environment: {
      required: [],
      optional: [],
    },
    dependencyServices: [],
  };
}

function runtimeProbeKind(runtime: NonNullable<ArchitectureArtifactContract["runtimeDelivery"]>): DeploymentRuntimeContract["probeKind"] {
  const surfaces = runtime.runtimeSurfaces ?? [];
  if (
    runtime.httpProbes?.previewPath ||
    runtime.httpProbes?.healthPath ||
    (runtime.httpProbes?.apiPaths ?? []).length > 0 ||
    surfaces.some((surface) => surface.kind === "http" || surface.probe.type === "http_path")
  ) {
    return "http";
  }
  if (surfaces.some((surface) => surface.probe.type === "command")) {
    return "command";
  }
  return "process";
}

function contractDependencyServices(
  runtime: NonNullable<ArchitectureArtifactContract["runtimeDelivery"]>,
): DeploymentRuntimeContract["dependencyServices"] {
  const signals = [
    runtime.runtimeKind,
    runtime.api?.kind,
    runtime.deliveryMechanics?.api?.basePath,
    ...(runtime.environment?.required ?? []),
    ...(runtime.environment?.optional ?? []),
    ...(runtime.httpProbes?.apiPaths ?? []),
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
  const services: DeploymentRuntimeContract["dependencyServices"] = [];

  if (/postgres|postgresql|pgsql|jdbc:postgresql/.test(signals)) {
    services.push({
      ...serviceDefinition("postgres", "Declared by RuntimeDeliveryContract environment/runtime signals."),
      connectionEnv: springDatasourceEnv("postgres"),
    });
  }
  if (/mysql|mariadb|jdbc:mysql|jdbc:mariadb/.test(signals)) {
    services.push({
      ...serviceDefinition("mysql", "Declared by RuntimeDeliveryContract environment/runtime signals."),
      connectionEnv: springDatasourceEnv("mysql"),
    });
  }
  if (/redis|redis_url|spring_redis|spring_data_redis/.test(signals)) {
    services.push(serviceDefinition("redis", "Declared by RuntimeDeliveryContract environment/runtime signals."));
  }
  if (/mongodb|mongo|mongodb_url|spring_data_mongodb/.test(signals)) {
    services.push(serviceDefinition("mongodb", "Declared by RuntimeDeliveryContract environment/runtime signals."));
  }
  if (/rabbitmq|amqp|rabbitmq_url|spring_rabbit/.test(signals)) {
    services.push(serviceDefinition("rabbitmq", "Declared by RuntimeDeliveryContract environment/runtime signals."));
  }
  if (/elasticsearch|opensearch/.test(signals)) {
    services.push(serviceDefinition("elasticsearch", "Declared by RuntimeDeliveryContract environment/runtime signals."));
  }
  if (/minio|s3_endpoint|s3-compatible/.test(signals)) {
    services.push(serviceDefinition("minio", "Declared by RuntimeDeliveryContract environment/runtime signals."));
  }

  return dedupeServices(services);
}

function springDatasourceEnv(kind: "postgres" | "mysql"): Record<string, string> {
  if (kind === "postgres") {
    return {
      DATABASE_URL: "postgresql://loom:loom@postgres:5432/loom",
      SPRING_DATASOURCE_URL: "jdbc:postgresql://postgres:5432/loom",
      SPRING_DATASOURCE_USERNAME: "loom",
      SPRING_DATASOURCE_PASSWORD: "loom",
    };
  }
  return {
    DATABASE_URL: "mysql://loom:loom@mysql:3306/loom",
    SPRING_DATASOURCE_URL: "jdbc:mysql://mysql:3306/loom",
    SPRING_DATASOURCE_USERNAME: "loom",
    SPRING_DATASOURCE_PASSWORD: "loom",
  };
}

function dedupeServices(services: DeploymentRuntimeContract["dependencyServices"]): DeploymentRuntimeContract["dependencyServices"] {
  const seen = new Set<string>();
  return services.filter((service) => {
    if (seen.has(service.kind)) {
      return false;
    }
    seen.add(service.kind);
    return true;
  });
}
