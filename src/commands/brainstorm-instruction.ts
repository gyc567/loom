import type { BrainstormStartResult } from "../core/operations/brainstorm";
import {
  brainstormAskUserInstructionPolicy,
  brainstormAskUserReadStep,
} from "../core/operations/output-policy";

export function brainstormStartInstruction(result: BrainstormStartResult): Record<string, unknown> {
  return {
    mode: "ask_user",
    ...brainstormAskUserInstructionPolicy(),
    requestRef: result.requestPath,
    candidateFile: result.request.outputContract.candidateFile,
    submitCommand: result.request.submitCommand,
    nextAction: {
      type: "brainstorm_clarification",
      source: "brainstorm_session_request",
      deliveryId: result.deliveryId,
      phaseId: result.phaseId,
      ref: result.requestPath,
      reason: "BRAINSTORM_SESSION_REQUEST_CREATED",
    },
    userMessage: "Read the BrainstormSessionRequest through requestRef, present the required progressive clarification blocks, then submit the confirmed BrainstormCandidate.",
    expectedResponse: {
      kind: "brainstorm_candidate_accept",
      rule: "Agent manages the Brainstorm conversation. Read requestRef and its requestManifest refs for agentAction, outputContract, rules, enumRefs, context refs, keyword hints, concept grounding, and frontend clarification protocol. After explicit user confirmation, write BrainstormCandidate to candidateFile and run submitCommand.",
      requestReadRule: brainstormAskUserReadStep,
      requestRef: result.requestPath,
      candidateFile: result.request.outputContract.candidateFile,
      submitCommand: result.request.submitCommand,
      currentTurnAnswerRule: {
        consumeCurrentUserMessage: true,
        meaning: "If the same user message that invoked @loom plan already contains clear phase scope, concept, frontend, and final confirmation details, treat it as the user's answer for the relevant Brainstorm gates instead of asking again.",
        doNotAskAgainWhenCurrentMessageIsExplicit: true,
        ifAmbiguousAskUser: true,
      },
    },
  };
}
