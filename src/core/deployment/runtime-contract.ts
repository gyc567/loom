import type { ArchitectureArtifactContract } from "../contracts";
import type { DeploymentRuntimeContract, DetectedStack } from "./types";

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
  };
}
