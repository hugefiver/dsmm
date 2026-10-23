/** Geometry and theme aliases extracted in dsmm/DESIGN.md; scoped to this section. */
export const PROFILE_STYLES = `
.dsmm-profiles{width:100%;max-width:760px;min-width:0;display:flex;flex-direction:column;gap:12px;font-family:var(--dsw-font-family);font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsmm-profiles h2{margin:0;font-size:18px;font-weight:600}
.dsmm-profiles h3,.dsmm-profiles legend{margin:0;font-size:14px;font-weight:500;line-height:22px}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) :is(label,legend,summary){min-width:0;max-width:100%;overflow-wrap:anywhere}
.dsmm-profiles :is(.dsmm-structured,.dsmm-session-scope,.dsmm-catalog,.dsmm-policy-fields){min-width:0;display:flex;flex-direction:column;gap:12px}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) fieldset{min-width:0;margin:0;padding:12px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);display:flex;flex-direction:column;gap:12px}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-route-fields{display:flex;flex-wrap:wrap;gap:12px;min-width:0}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-route-fields>.dsmm-field{flex:1 1 240px;max-width:100%}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-route-fields select{width:100%}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) summary{cursor:pointer;color:var(--dsw-alias-label-primary);min-height:32px;line-height:32px}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) summary:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsmm-profiles .dsmm-advanced[open]>div{margin-top:8px}
.dsmm-header-profiles{display:inline-flex;align-items:center;min-width:0;font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary)}
.dsmm-header-profiles .dsmm-profile-trigger{width:28px;height:28px;min-height:28px;padding:6px;justify-content:center}
.dsmm-profile-trigger:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsmm-profile-menu{font-family:var(--dsw-font-family);font-size:14px;line-height:22px;max-width:calc(100vw - 24px);color:var(--dsw-alias-label-primary)}
.dsmm-profile-menu [role=presentation]{font:inherit;white-space:normal;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.dsmm-profile-menu [role=menuitem]{font:inherit}
.dsmm-profile-menu [role=menuitem]>span{white-space:normal;overflow-wrap:anywhere}
.dsmm-profile-announcement{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) p{margin:0;overflow-wrap:anywhere}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-hint{color:var(--dsw-alias-label-secondary)}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-field{min-width:0;display:flex;flex-direction:column;gap:6px}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) button{max-width:100%;white-space:normal;overflow-wrap:anywhere;min-height:36px;height:auto}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-input{width:100%;min-width:0;box-sizing:border-box;border-color:var(--dsw-alias-label-secondary)}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-input input{width:100%;min-width:0;font:inherit;color:inherit}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-choice{position:relative;min-width:0}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-choice .dsmm-input input{padding-right:32px}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-choice .dsmm-choice-toggle{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:28px;height:28px;min-height:28px;padding:4px}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-choice-list{position:absolute;z-index:1;top:100%;left:0;right:0;max-height:240px;overflow-y:auto;list-style:none;margin:4px 0 0;padding:4px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-choice-list [role=option]{padding:8px 10px;min-width:0;overflow-wrap:anywhere;cursor:pointer}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-choice-list [role=option]:hover{background:var(--dsw-alias-interactive-bg-hover)}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-choice-list [aria-selected=true]{background:var(--dsw-alias-interactive-bg-active);outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) select,:is(.dsmm-profiles, .dsmm-profile-models-dialog) textarea{box-sizing:border-box;min-width:0;max-width:100%;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-md)}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) select{width:240px;height:32px;padding:0 10px;text-overflow:ellipsis}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) textarea{width:100%;padding:12px;font-family:var(--ds-font-family-code);resize:vertical;overflow:auto;white-space:pre;}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) select:hover:not(:disabled),:is(.dsmm-profiles, .dsmm-profile-models-dialog) textarea:hover:not(:disabled){border-color:var(--dsw-alias-label-primary)}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) select:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) :is(select,textarea,button):focus-visible,:is(.dsmm-profiles, .dsmm-profile-models-dialog) .dsmm-input:has(input:focus-visible){outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) input[type=checkbox]:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsmm-permissions label.dsmm-actions{min-height:32px}
.dsmm-permissions input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary)}
:is(.dsmm-profiles, .dsmm-profile-models-dialog) :is(select,textarea):disabled{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);cursor:not-allowed}
.dsmm-profiles .dsmm-editor,.dsmm-profiles .dsmm-confirm{min-width:0;display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}
.dsmm-profiles .dsmm-issue{padding:12px;border-left:4px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dsmm-profiles .dsmm-issue p+p{margin-top:8px}
.dsmm-profiles .dsmm-status{min-height:22px}
.dsmm-profiles .dsmm-zone{min-width:0;display:flex;flex-direction:column;gap:12px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l4)}
.dsmm-profiles .dsmm-profile-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:12px;min-width:0}
.dsmm-profiles .dsmm-profile-list li{min-width:0;display:flex;flex-direction:column;gap:4px}
.dsmm-profiles :is(.dsmm-warning,.dsmm-diagnostic,.dsmm-availability){min-width:0;display:flex;flex-direction:column;gap:4px;overflow-wrap:anywhere}
.dsmm-profiles .dsmm-warning{border-left:4px solid var(--dsw-alias-state-warn-primary);padding:8px 12px;color:var(--dsw-alias-label-primary)}
.dsmm-deployment{gap:8px}
.dsmm-section-tabs{display:flex;gap:8px;min-width:0;max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;border-bottom:1px solid var(--dsw-alias-border-l4);padding-bottom:2px}
.dsmm-section-tabs button{flex:0 0 auto;justify-content:center;white-space:nowrap;border-color:transparent;border-bottom:2px solid transparent;border-radius:var(--dsw-radius-md) var(--dsw-radius-md) 0 0;background:transparent;color:var(--dsw-alias-label-secondary);font-weight:400}
.dsmm-section-tabs button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsmm-section-tabs button[aria-selected=true]{background:var(--dsw-alias-interactive-bg-active);border-bottom-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-weight:500}
.dsmm-section-panel{display:flex;flex-direction:column;gap:16px;min-width:0;width:100%;box-sizing:border-box}
.dsmm-panel-heading{display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;align-items:center;min-width:0}
.dsmm-panel-heading h2:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsmm-rules-transaction{padding-top:16px}
.dsmm-scope-save{display:flex;flex-direction:column;gap:8px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l4)}
.dsmm-deployment .dsmm-deployment-group{border-top:1px solid var(--dsw-alias-border-l4);padding-top:8px;min-width:0}
.dsmm-deployment .dsmm-deployment-group>div{display:flex;flex-direction:column;gap:8px;padding-top:8px}
.dsmm-deployment .dsmm-deployment-group>summary.dsmm-group-summary-row{display:flex;align-items:center;gap:8px;list-style:none}
.dsmm-deployment .dsmm-deployment-group>summary.dsmm-group-summary-row::-webkit-details-marker{display:none}
.dsmm-deployment .dsmm-deployment-group>summary.dsmm-group-summary-row::before{content:"▶";flex:0 0 auto;width:12px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dsmm-deployment .dsmm-deployment-group[open]>summary.dsmm-group-summary-row::before{content:"▼"}
.dsmm-deployment summary .dsmm-group-summary{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto}
.dsmm-deployment .dsmm-group-summary-label{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.dsmm-deployment .dsmm-group-summary-action{flex:0 0 auto;min-height:28px;height:28px;padding:0 8px}
.dsmm-deployment .dsmm-group-summary-action[hidden]{display:none}
.dsmm-deployment code{font-family:var(--ds-font-family-code);overflow-wrap:anywhere}
.dsmm-deployment label code,.dsmm-deployment summary code{margin-left:8px;font-size:12px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.dsmm-deployment pre{margin:0;max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--ds-font-family-code)}
.dsmm-deployment .dsmm-deployment-state{display:flex;flex-direction:column;gap:4px;margin:0;padding:12px;border-top:1px solid var(--dsw-alias-border-l4)}
.dsmm-deployment .dsmm-deployment-state dd{margin:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsmm-children .dsmm-child-composer{min-width:0;display:flex;flex-direction:column;gap:12px}
.dsmm-children .dsmm-child-meta{margin:0;display:flex;flex-direction:column;gap:4px;min-width:0}
.dsmm-children .dsmm-child-meta dt{font-weight:500;overflow-wrap:anywhere}
.dsmm-children .dsmm-child-meta dd{margin:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsmm-children textarea.dsmm-child-message{font-family:var(--dsw-font-family);white-space:pre-wrap;overflow-wrap:anywhere}
.dsmm-profiles .dsmm-command-entry{min-width:0;display:flex;flex-direction:column;gap:6px}
.dsmm-profiles .dsmm-command-entry .dsmm-actions{display:flex;align-items:center;gap:8px}
.dsmm-profiles .dsmm-command-entry .dsmm-input{flex:1 1 auto;min-width:0}
.dsmm-profiles .dsmm-command-summary{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.dsmm-profiles .dsmm-command-summary code{font-family:var(--ds-font-family-code);font-size:13px;color:var(--dsw-alias-label-primary)}
.dsmm-profiles .dsmm-legacy-badge{display:inline-flex;align-items:center;padding:2px 6px;font-size:11px;font-weight:600;line-height:16px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:0.5px}
.dsmm-profiles .dsmm-legacy-details{padding:4px 0}
.dsmm-profiles .dsmm-legacy-details summary{font-size:12px;color:var(--dsw-alias-label-secondary);min-height:24px;line-height:24px}
.dsmm-profiles .dsmm-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:4px 0 0;font-size:12px}
.dsmm-profiles .dsmm-kv dt{font-weight:500;color:var(--dsw-alias-label-secondary)}
.dsmm-profiles .dsmm-kv dd{margin:0;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code)}
.dsmm-named-profiles .dsmm-browse-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsmm-named-profiles .dsmm-effective-summary{display:flex;flex-direction:column;gap:8px;padding:12px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md)}
.dsmm-named-profiles .dsmm-summary-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.dsmm-named-profiles .dsmm-summary-label{display:inline-flex;align-items:center;gap:6px;font-weight:500}
.dsmm-named-profiles .dsmm-summary-val{color:var(--dsw-alias-label-secondary)}
.dsmm-named-profiles .dsmm-more-actions{border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);padding:8px 12px}
.dsmm-named-profiles .dsmm-more-actions[open]{padding-bottom:12px}
.dsmm-named-profiles .dsmm-more-actions>summary{font-weight:500}
.dsmm-named-profiles .dsmm-more-actions>div{margin-top:12px;display:flex;flex-direction:column;gap:12px}
.dsmm-named-profiles .dsmm-basic-settings{display:flex;flex-direction:column;gap:12px;padding:12px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md)}
.dsmm-named-profiles .dsmm-advanced-settings{border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);padding:8px 12px}
.dsmm-named-profiles .dsmm-advanced-settings[open]{padding-bottom:12px}
.dsmm-named-profiles .dsmm-advanced-settings>summary{font-weight:500}
.dsmm-named-profiles .dsmm-advanced-settings>div{margin-top:12px;display:flex;flex-direction:column;gap:12px}
.dsmm-named-profiles .dsmm-save-bar{display:flex;flex-direction:column;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l4)}
.dsmm-named-profiles .dsmm-save-lock-reason{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}
.dsmm-named-profiles .dsmm-save-lock-text{font-weight:500;color:var(--dsw-alias-state-warn-primary)}
.dsmm-named-profiles .dsmm-save-lock-action{display:flex;align-items:center;gap:8px}
.dsmm-named-profiles .dsmm-orchestrator-primary{background:var(--dsw-alias-bg-layer-1)}
.dsmm-named-profiles .dsmm-git-guard{background:var(--dsw-alias-bg-layer-1)}
.dsmm-named-profiles .dsmm-structured-invalid{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}

.dsmm-profile-models-dialog.dialog,
.dsmm-profile-models-dialog{width:min(1040px, calc(100vw - 32px))!important;max-width:1040px!important;max-height:calc(100vh - 48px)!important;display:flex!important;flex-direction:column!important;overflow:hidden!important;box-sizing:border-box;font-family:var(--dsw-font-family);font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsmm-profile-models-dialog-content,
.dsmm-models-dialog-content,
.dsmm-profile-models-dialog .dsmm-profile-models-dialog-content{overflow-y:auto!important;overflow-x:hidden;display:flex;flex-direction:column;gap:12px;padding:4px 0 16px;min-height:0;flex:1 1 auto}
.dsmm-models-filter-bar,
.dsmm-dialog-filter-bar,
.dsmm-profile-models-dialog .dsmm-filter-bar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l4);flex-shrink:0}
.dsmm-models-filter-bar .dsmm-search-input,
.dsmm-filter-search{flex:1 1 240px;min-width:0}
.dsmm-filter-label,
.dsmm-filter-override-toggle{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;user-select:none;color:var(--dsw-alias-label-primary)}
.dsmm-dialog-issue{margin-bottom:8px;padding:8px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);display:flex;flex-direction:column;gap:6px}
.dsmm-dialog-issue-title{font-weight:600;color:var(--dsw-alias-state-error-primary);margin:0}
.dsmm-dialog-issue-action{display:flex;justify-content:flex-end;margin-top:4px}
.dsmm-profile-models-dialog .dsmm-roles-list,
.dsmm-profile-models-dialog .dsmm-dialog-roles-list{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsmm-profile-models-dialog .dsmm-dialog-role-card{display:flex;flex-direction:column;gap:6px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);min-width:0}
.dsmm-profile-models-dialog .dsmm-role-main-row{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:8px 12px;min-width:0}
.dsmm-profile-models-dialog .dsmm-dialog-role-header{display:flex;align-items:center;min-width:140px;flex:0 0 auto}
.dsmm-profile-models-dialog .dsmm-role-title-group{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0}
.dsmm-profile-models-dialog .dsmm-role-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsmm-profile-models-dialog .dsmm-role-id-badge{font-family:var(--ds-font-family-code);font-size:11px;padding:1px 4px;border-radius:var(--dsw-radius-xs,2px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsmm-profile-models-dialog .dsmm-override-badge{font-size:11px;padding:1px 6px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-state-business-primary);border:1px solid var(--dsw-alias-state-business-primary);white-space:nowrap}
.dsmm-profile-models-dialog .dsmm-role-primary-route{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px 12px;flex:1 1 auto;justify-content:flex-end;min-width:0}
.dsmm-profile-models-dialog .dsmm-role-primary-route .dsmm-primary-mode-field{flex:0 0 auto;min-width:110px}
.dsmm-profile-models-dialog .dsmm-role-primary-route .dsmm-primary-mode-field select{width:auto;min-width:110px;height:32px}
.dsmm-profile-models-dialog .dsmm-role-primary-route .dsmm-route-fields{display:flex;flex-wrap:nowrap;align-items:flex-end;gap:8px;flex:0 1 auto;min-width:0}
.dsmm-profile-models-dialog .dsmm-role-primary-route .dsmm-route-fields>.dsmm-field{flex:0 1 auto;min-width:100px;max-width:200px;gap:2px}
.dsmm-profile-models-dialog .dsmm-role-primary-route .dsmm-route-fields select{width:100%;height:32px}
.dsmm-profile-models-dialog .dsmm-role-primary-route .dsmm-route-fields .dsmm-input{height:32px}
.dsmm-profile-models-dialog .dsmm-route-inherited-hint{font-size:12px;color:var(--dsw-alias-label-secondary);padding:6px 0;line-height:20px}
.dsmm-profile-models-dialog .dsmm-orchestrator-tag{font-size:12px;color:var(--dsw-alias-label-secondary);padding:6px 0;line-height:20px}
.dsmm-profile-models-dialog .dsmm-role-details-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;min-width:0;padding-top:4px;border-top:1px dashed var(--dsw-alias-border-l4)}
.dsmm-profile-models-dialog .dsmm-compact-details{display:inline-block;min-width:0}
.dsmm-profile-models-dialog .dsmm-compact-details[open]{flex:1 1 100%;width:100%}
.dsmm-profile-models-dialog .dsmm-details-pill{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l4);font-size:12px;line-height:20px;min-height:24px;cursor:pointer;color:var(--dsw-alias-label-primary);user-select:none}
.dsmm-profile-models-dialog .dsmm-compact-details[open]>.dsmm-details-pill{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-state-business-primary);font-weight:500}
.dsmm-profile-models-dialog .dsmm-pill-label{color:var(--dsw-alias-label-secondary)}
.dsmm-profile-models-dialog .dsmm-pill-val{color:var(--dsw-alias-label-primary)}
.dsmm-profile-models-dialog .dsmm-compact-details .dsmm-details-content{margin-top:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:10px;min-width:0}
.dsmm-profile-models-dialog .dsmm-fallback-item{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);min-width:0}
.dsmm-models-dialog-footer{display:flex;justify-content:flex-end;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l4)}

@media(max-width:768px){
  .dsmm-profile-models-dialog{width:calc(100vw - 16px)!important;max-height:calc(100vh - 16px)}
  .dsmm-profile-models-dialog .dsmm-dialog-role-card{padding:10px}
  .dsmm-profile-models-dialog .dsmm-role-main-row{flex-direction:column;align-items:stretch;gap:8px}
  .dsmm-profile-models-dialog .dsmm-role-primary-route{flex-direction:column;align-items:stretch;gap:8px}
  .dsmm-profile-models-dialog .dsmm-role-primary-route .dsmm-route-fields{flex-wrap:wrap}
  .dsmm-profile-models-dialog .dsmm-role-primary-route .dsmm-route-fields>.dsmm-field{flex:1 1 100%;max-width:100%}
  .dsmm-profile-models-dialog .dsmm-role-details-bar{flex-direction:column;align-items:stretch}
  .dsmm-profile-models-dialog .dsmm-compact-details{width:100%}
  .dsmm-profile-models-dialog .dsmm-details-pill{width:100%;box-sizing:border-box;justify-content:space-between}
}
@media(prefers-reduced-motion:reduce){:is(.dsmm-profiles, .dsmm-profile-models-dialog) *{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
`;
