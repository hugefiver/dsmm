export const smokeFiles = Object.freeze([
  "client-deployment-validation.test.ts",
  "deployment-config.test.ts",
  "model-family.test.ts",
  "package.test.ts",
  "permission-rules.test.ts",
  "profiles.test.ts",
  "route-json.test.ts",
  "runtime-recovery-types.test.ts",
  "skills.test.ts",
]);

export const moduleSuites = Object.freeze({
  permissions: Object.freeze([
    /^(?:command-approval|deployment-permission|git-command-approval|guards|permission-|shell-command|web-fetch-)/u,
    /^client-permission/u,
    /^native-(?:approval-authority|policy-capture|preset-security|readonly-shell)/u,
  ]),
  "config-profiles": Object.freeze([
    /^(?:config|configuration|deployment-config|modules-rpc|profile|profiles|preset|session-profile|settings|status|surface-rpc)/u,
    /^client-(?:deployment|profile)/u,
    /^native-(?:deployment-config|modules|profile|preset)/u,
  ]),
  "native-runtime": Object.freeze([
    /^(?:host-|legacy-session|lsp|managed-activation|native-|recovery-policy|runtime-|session-(?!profile)|state|wave1-foundation)/u,
  ]),
  "routing-model": Object.freeze([
    /^(?:agent-presets|child-|commands|configured-root-|mode|model-|role-|roles|root-|route-)/u,
    /^client-(?:children|native-model-intent|role-tool)/u,
    /^native-(?:context-identification|delegation|model|request|root|route|role)/u,
  ]),
  "frontend-package": Object.freeze([
    /^(?:assets|client-|frontend-|generate-role-assets|ordinary-module-delivery|package)/u,
  ]),
  "workflow-resources": Object.freeze([
    /^(?:plan-validation|prompt-|prompts|skills)/u,
  ]),
});

export const integrationSuites = Object.freeze({
  "native-runtime": Object.freeze([
    "host-core-integration.test.ts",
    "host-llm-startup.test.ts",
    "native-approval-authority.test.ts",
    "native-modules.test.ts",
    "native-readonly-shell.test.ts",
    "native-root-llm.test.ts",
    "native-runtime-bundle.test.ts",
    "native-session-resume-refresh.test.ts",
  ]),
  frontend: Object.freeze([
    "client-deployment-core-browser.test.ts",
    "client-editable-choice-browser.test.ts",
    "client-named-profiles-browser.test.ts",
    "client-role-tool-view.test.ts",
  ]),
  delivery: Object.freeze([
    "frontend-materialization.test.ts",
    "native-root-llm.test.ts",
    "native-runtime-bundle.test.ts",
    "ordinary-module-delivery.test.ts",
  ]),
});
