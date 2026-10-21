import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-gateway/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-api-session-controller/remote";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-model-selection/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import { TYPERT_REMOTE } from "../profile-remote.js";
import { ProfilesController } from "./controller.js";
import { NS, en, zh } from "./locales.js";
import { ProfilesSection } from "./ProfilesSection.js";
import { PROFILE_STYLES } from "./styles.js";
import { SessionProfiles } from "./SessionProfiles.js";
import type {} from "./plugins-contract.js";
import { DeploymentController } from "./deployment-controller.js";
import { DeploymentPage } from "./DeploymentPage.js";
import { deploymentWorkspace } from "./deployment-workspace.js";
import { DEPLOYMENT_NS, deploymentEn, deploymentZh } from "./deployment-locales.js";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import { ROLE_CONTROL_REMOTE } from "../role-control-remote.js";
import { PERMISSION_REMOTE } from "../permission-remote.js";
import { permissionClient } from "./permission-client.js";
import { bindPermissionSession } from "./permission-session.js";
import { PermissionController } from "./permission-controller.js";
import { PERMISSIONS_NS, permissionEn, permissionZh } from "./permission-locales.js";
import { registerRoleToolViews } from "./RoleToolView.js";

export { ProfilesController, NEW_PROFILE_CONTENT } from "./controller.js";
export type { ProfilesActions, ProfilesViewSnapshot, ProfilesIssue, SessionApplyOptions, ProfileModelSelectorRemote } from "./controller.js";
export { ProfilesSection } from "./ProfilesSection.js";
export type { ProfilesSectionProps, ProfilesInjected } from "./ProfilesSection.js";
export { NS, en, zh } from "./locales.js";
export { TYPERT_REMOTE } from "../profile-remote.js";
export { SessionProfiles } from "./SessionProfiles.js";
export { structuredDocument, editStructuredPath, moveFallback } from "./structured.js";
export { ChildrenController } from "./children-controller.js";
export type { ChildrenActions, ChildrenSnapshot, ChildrenIssue } from "./children-controller.js";
export { ChildrenPanel } from "./ChildrenPanel.js";
export { ROLE_CONTROL_REMOTE } from "../role-control-remote.js";

/** No self-dependency on a namespace that this contribution has not mounted. */
export const inject = ["slots", "locale", "remote"] as const;

export async function apply(ctx: Context): Promise<void> {
  registerRoleToolViews(ctx);
  await ctx.remote.$mount(TYPERT_REMOTE);
  await ctx.remote.$mount(ROLE_CONTROL_REMOTE);
  await ctx.remote.$mount(PERMISSION_REMOTE);
  const permissions = new PermissionController();
  ctx.effect(() => () => permissions.dispose(), "dsmm: permission controls");
  ctx.effect(() => ctx.locale.register(PERMISSIONS_NS, { en: permissionEn, zh: permissionZh }), "dsmm: permission locale");
  void ctx.inject(["connection"], connectionCtx => {
    const handle = connectionCtx.connection as unknown as ConnectionHandle, invoke = permissionClient(handle);
    const update = () => { const generation = handle.generation.getSnapshot(); permissions.bindConnection(generation === undefined ? null : invoke, generation); };
    update(); connectionCtx.effect(() => handle.generation.subscribe(update));
    connectionCtx.effect(() => () => permissions.bindConnection(null), "dsmm: permission connection withdrawal");
  });
  void ctx.inject(["uiSession", "sessions"], sessionCtx => {
    const source = sessionCtx.uiSession.adapter.current, sessions = sessionCtx.sessions as unknown as ISessions;
    sessionCtx.effect(() => bindPermissionSession(source, sessions, permissions), "dsmm: permission native session withdrawal");
  });
  let deployment: DeploymentController | null = null;
  let profiles: ProfilesController | null = null;
  // This core-owned graph must not depend on DW, named profiles or a session.
  await ctx.inject(["remote.dsmmConfig"], (coreCtx) => {
    const core = new DeploymentController(coreCtx.remote.dsmmConfig, "global");
    const workspace = deploymentWorkspace(core, permissions);
    void coreCtx.inject(["connection"], connectionCtx => {
      core.bindConnection((connectionCtx.connection as unknown as ConnectionHandle).generation);
      void core.refresh();
    });
    deployment = core;
    if (profiles !== null) core.setSession(profiles.store.getSnapshot().session);
    coreCtx.effect(() => () => { deployment = null; workspace.dispose(); core.dispose(); }, "dsmm: core settings editor");
    coreCtx.effect(() => coreCtx.locale.register(DEPLOYMENT_NS, { en: deploymentEn, zh: deploymentZh }), "dsmm: core locale");
    coreCtx.effect(() => {
      const style = document.createElement("style"); style.dataset.dsmmSettings = ""; style.textContent = PROFILE_STYLES;
      document.head.append(style); return () => style.remove();
    }, "dsmm: core styles");
    const inject = () => ({ core, remote: coreCtx.remote.dsmmConfig, workspace, permissionsT: coreCtx.locale.bind(PERMISSIONS_NS) });
    coreCtx.slots.inject("plugins.bundle.config", () => coreCtx.slots.register({ name: "plugins.bundle.config", key: "@dsmm/dsmm", locale: DEPLOYMENT_NS, inject }, DeploymentPage));
    // The canonical bundle owner passes only view. Namespace comes from the authenticated snapshot.
    void coreCtx.inject(["configForms"], formCtx => {
      workspace.bindForms(formCtx.configForms);
      formCtx.effect(() => () => workspace.bindForms(null));
    });
    void core.refresh();
  });
  await ctx.inject(["remote.dsmmProfiles"], (profileCtx) => {
    const controller = new ProfilesController(profileCtx.remote.dsmmProfiles);
    void profileCtx.inject(["connection"], connectionCtx => {
      controller.bindConnection((connectionCtx.connection as unknown as ConnectionHandle).generation);
      void controller.refresh();
      connectionCtx.effect(() => () => controller.bindConnection(null), "dsmm: profile connection withdrawal");
    });
    profiles = controller;
    profileCtx.effect(() => controller.store.subscribe(() => { deployment?.setSession(controller.store.getSnapshot().session); }));
    profileCtx.effect(() => () => { profiles = null; deployment?.setSession(null); });
    profileCtx.effect(() => () => controller.dispose(), "dsmm: profile editor");
    profileCtx.effect(() => profileCtx.locale.register(NS, { en, zh }), "dsmm: profile locale");
    profileCtx.effect(() => {
      const style = document.createElement("style");
      style.dataset.dsmmProfiles = "";
      style.textContent = PROFILE_STYLES;
      document.head.append(style);
      return () => style.remove();
    }, "dsmm: profile styles");
    const t = profileCtx.locale.bind(NS);
    void profileCtx.inject(["conversation"], conversationCtx => {
      controller.attachComposerBlocks(conversationCtx.conversation.blocks, () => t("sessionSelectionBlock"));
      conversationCtx.effect(() => () => controller.attachComposerBlocks(null), "dsmm: profile composer block lifetime");
    });
    profileCtx.slots.inject("settings.section", () => profileCtx.slots.register({
      name: "settings.section", id: "dsmm-profiles", order: 30,
      label: () => t("title"), locale: NS,
      inject: () => ({ hooks: { profiles: controller.store }, ...controller.actions }),
    }, ProfilesSection));
    // Lowest numeric priority wins in native SlotCore. This root-scoped
    // fallback never replaces ordinary native/plugin leading navigation.
    profileCtx.slots.inject("conversation.header.leading", () => profileCtx.slots.register({
      name: "conversation.header.leading", priority: Number.MAX_SAFE_INTEGER, locale: NS,
      inject: () => ({ hooks: { profiles: controller.store }, ...controller.actions }),
    }, SessionProfiles));
    // Optional native services have their own lifetime. Do not await them or
    // make sessionless Settings depend on a Conversation/session provider.
    void profileCtx.inject(["remote.session"], (catalogCtx) => {
      controller.attachCatalog(catalogCtx.remote.session);
      controller.attachModelSelector(catalogCtx.remote.session);
      catalogCtx.effect(() => () => { controller.attachModelSelector(null); controller.attachCatalog(null); }, "dsmm: native catalog/selector lifetime");
    });
    void profileCtx.inject(["uiSession", "sessions"], (sessionCtx) => {
      const source = sessionCtx.uiSession.adapter.current;
      // This adapter compiles with both Host and Client Cordis declarations;
      // the injected browser service has the public Client Sessions face.
      const nativeSessions = sessionCtx.sessions as unknown as ISessions;
      const update = () => {
        const binding = source.getSnapshot();
        controller.setSession(binding.key ?? null);
        controller.attachModelSelectionSource(binding.key ?? null, binding.key === undefined ? null : binding.keyedHooks.projection?.("modelSelection") ?? null);
        controller.attachModelEventSource(binding.key ?? null, binding.key === undefined ? null : nativeSessions.binding(binding.key as SessionId)?.eventSource ?? null);
      };
      update();
      sessionCtx.effect(() => source.subscribe(update), "dsmm: current native session");
      sessionCtx.effect(() => () => { controller.attachModelSelectionSource(null, null); controller.attachModelEventSource(null, null); controller.attachModelInteractionSource(null, null); controller.setSession(null); }, "dsmm: native session withdrawal");
      void sessionCtx.inject(["modelDirectories", "remote.session"], (modelCtx) => {
        const updateInteraction = () => {
          const id = source.getSnapshot().key;
          if (id === undefined || nativeSessions.binding(id as SessionId) === undefined) { controller.attachModelInteractionSource(null, null); return; }
          try { controller.attachModelInteractionSource(id, modelCtx.modelDirectories.directoryFor(id as SessionId).store); }
          catch { controller.attachModelInteractionSource(null, null); } // An ended native scope fails closed for the optional model stage.
        };
        updateInteraction();
        modelCtx.effect(() => source.subscribe(updateInteraction), "dsmm: native model interaction binding");
        modelCtx.effect(() => () => controller.attachModelInteractionSource(null, null), "dsmm: native model interaction withdrawal");
      });
    });
  });
}
