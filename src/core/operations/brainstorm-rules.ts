export function nextPhasePreviewCandidateRules(): string[] {
  return [
    "phasePlan.nextPhasePreview is a non-binding seed for the next Brainstorm, not a confirmed future-phase scope.",
    "When original requirement text, current scope.deferred, or current scope.excluded indicates remaining capabilities, keep nextPhasePreview.kind=candidate and make scopePreview list concrete source-grounded business objects, actions, or workflows.",
    "Do not use nextPhasePreview.kind=none to mean the next phase is uncertain; use kind=none only when the current confirmed delivery has no remaining phase candidate.",
    "When multiple next directions remain, keep kind=candidate and make scopePreview a concrete candidate set for the next Brainstorm to confirm or narrow.",
    "Generic continuation labels are insufficient as the primary scopePreview content unless each item also names source-derived business objects, actions, or workflows.",
    "When contextRefs.normalizedRequirementTextRef or contextRefs.keywordHintsRef is present, use them as source/advisory context for nextPhasePreview wording; keyword hints are never scope or acceptance authority.",
  ];
}

export function phaseScopeOptionComparisonRules(): string[] {
  return [
    "During the phase_scope block, when the current phase boundary has real alternative cuts, present 2-3 source-grounded phase scope options before asking for confirmation.",
    "Each phase_scope option must identify included scope, excluded/deferred boundary, the reason for that cut, and the tradeoff for delivery speed, completeness, and implementation risk.",
    "Recommend exactly one phase_scope option and explain why it is the best current-phase cut.",
    "When the current phase boundary has only one clear source-grounded cut, present that single scope and explicitly state that meaningful alternatives were not found; do not fabricate extra options.",
    "A confirmed phase_scope option must be reflected in scope.included, scope.excluded, scope.deferred, phasePlan.current, and phasePlan.nextPhasePreview using the existing BrainstormCandidate fields.",
  ];
}

export function brainstormCandidateSelfReviewRules(): string[] {
  return [
    "Before writing or submitting BrainstormCandidate, perform a self-review against the final_summary and the confirmed phase_scope option.",
    "Self-review must verify that confirmed requirement details are stored in existing BrainstormCandidate fields rather than only in chat: scope.included[].items, acceptance[].statement, domainModel.businessFlows[].summary, conceptGrounding, frontendExperience/frontendExperienceDelta, and phasePlan.nextPhasePreview.",
    "Self-review must check that scope items name concrete objects, actions, rules, fields, states, or boundaries when those details were confirmed.",
    "Self-review must check that acceptance statements are executable outcomes and that businessFlows summarize flow steps, preconditions, validation or blocking rules, blocking reasons, success state, and input/display/pass-through fields when applicable.",
    "If self-review finds that a required detail is unclear or missing from the existing fields, return to the relevant Brainstorm block and ask the user before submitting; do not let PGC, AAC, TaskPlan, or TaskExecution rediscover that detail later.",
    "Do not create a separate Markdown spec, commit, or parallel requirement artifact for this self-review; the accepted BrainstormCandidate remains the requirement contract.",
  ];
}

export function brainstormRequirementSemanticRules(): string[] {
  return [
    "Brainstorm must read the original requirement refs and any confirmed requirement decision refs before presenting a final_summary or writing BrainstormCandidate.",
    "For the user-confirmed current phase, preserve requirement semantics in existing BrainstormCandidate fields; do not reduce the phase to a vague label such as implement feature, fix bug, continue expansion, or optimize page.",
    "The Agent, not the CLI, decides whether the current phase involves business flows, user operations, state changes, forms/fields, validation/blocking rules, or frontend/backend interaction. If it does, the final_summary block must show a business-detail confirmation covering current-phase flows, preconditions, validation rules, blocking rules and reasons, success conditions and state changes, fields to input/display/pass through, deferred or not-done details, and source refs.",
    "If those business-detail categories do not apply to the current phase, the final_summary block must state the concrete not-applicable reason, such as this phase only changing build configuration, test harnesses, deployment files, or other non-domain technical work.",
    "When business-detail confirmation applies, write the confirmed details into existing BrainstormCandidate fields: scope.included[].items for modules/actions/rules/fields/boundaries; acceptance[].statement for verifiable business outcomes; domainModel.businessFlows[].summary for flow steps, preconditions, validation/blocking, and success state; conceptGrounding for high-risk concepts, hard rules, and misunderstanding boundaries; frontendExperience/frontendExperienceDelta for required input, display, and feedback expectations.",
    "For correction, completion, or optimization phases, describe the expected behavior from original/confirmed requirements, the current implemented behavior from latestRepositoryContext, the confirmed delta for this phase, and the target behavior after correction using the same existing fields.",
    "For technical or non-domain phases, do not fabricate domain rules; instead express technical workflow, constraints, boundaries, expected behavior, and verification responsibilities in scope, acceptance, domainModel.businessFlows when useful, and conceptGrounding only when there are real high-risk concepts.",
    "Every current-phase acceptance statement must be source-grounded: cite sourceRefs from original requirements, confirmed decisions, user confirmation, or repository facts as appropriate; keywordHints are never acceptance authority.",
    "If a required semantic detail for the confirmed current phase is unclear after reading the provided refs, ask the user in the relevant Brainstorm block before accepting; do not let downstream PGC/AAC/TaskPlan rediscover missing requirement rules from scratch.",
    "frontendExperience/frontendExperienceDelta is required only for UI or user-visible workflow phases; conceptGrounding may be none_required or not_applicable only with a concrete reason.",
  ];
}
