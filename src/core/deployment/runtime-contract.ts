import type { ArchitectureArtifactContract } from "../contracts";
import type { DeploymentRuntimeContract, DetectedStack } from "./types";
import {
  dedupeDependencyServices,
  dependencyServiceKindsFromRuntimeSignals,
  isSqlServiceKind,
  serviceDefinition,
  springDatasourceEnv,
} from "./dependency-signals";

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

  for (const kind of dependencyServiceKindsFromRuntimeSignals(signals)) {
    const service = serviceDefinition(kind, "Declared by RuntimeDeliveryContract environment/runtime signals.");
    services.push(isSqlServiceKind(kind)
      ? { ...service, connectionEnv: springDatasourceEnv(kind) }
      : service);
  }

  return dedupeDependencyServices(services);
}
