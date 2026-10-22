# 命令风险范围与存活会话规则批准

## 目标与约束

DSMM 对命令实行更准确、更少重复的审批：只读 Git 查询不触发写入保护；自动 Git 保护可选择全部已知写入或仅高危动作；用户批准某条 DSMM 命令规则后，同一存活 Agent 后续匹配该规则的调用不再重复询问该条规则。记忆允许规则覆盖的参数变化，不是整条命令文本白名单。

- 工作、构建和测试仅在独立 `dsmm` 仓库内。保持 `@dsmm/dsmm` 0.3.11 和 DSH `0.2.1-rc.2` 不变。
- 不安装依赖，不执行 Git 写操作、发布、用户 profile 或 ACL 修改。测试中的 Shell 使用计数执行器，不实际运行破坏命令。
- 不新增全系统危险命令拦截器，不展开脚本、Git alias、动态执行或第三方工具后端。沿用现有 shell/Git 识别边界。
- 保留 `guards.gitWriteGuard: ask | deny | off`、guard 激活范围、原生所有权、readonly、工具注册身份、输入隔离和权限上限。
- 记忆仅属于精确的存活 Agent 对象，不按 session ID、root ID、工具名或进程全局共享；不传给 child，不写入配置或日志作为可恢复授权，不跨恢复、重启或控制器退休。
- 缓存只消除 DSMM 自己的 ask 义务。原生/第三方 ask、deny、cancel、`approval.policy=never` 及新的提权请求继续有权决定当前调用。
- 原生 `allowed-once`、`approvedTarget` 和 sandbox target 消费仍是单次调用事实，不可作为会话缓存的权限凭证。

## 已有接口与实施依据

- `src/shell-command.ts`：`classifyKnownGitWrite()` 当前返回第一个写入名称；`parseShellCommand()` 已提供分段和有限的 env/Git 全局选项处理。新增风险评估须扫描全部段，不能筛选完第一个普通写入就结束。
- `src/guards.ts`：`gitWriteDecision()` 产生 generic ask；`registerSafetyGuards()` 组合下游 decision。当前 generic ask 没有最终批准回调。
- `src/permission-native-rules.ts`：显式 shell 规则是 executable + 完整 command + workingDirectory 精确匹配；必须保留匹配规则身份，不能仅传递折叠后的 action。
- `src/permission-native-command.ts`：对象型 nativeCommands 规则匹配 tool、cwd、executable、subcommand，允许其参数尾部变化；字符串 simple 规则是已有 allow 路径，不是新增 ask 规则。不得借此任务改变两种语法或 simple 权限语义。
- `src/permission-control.ts`：`composeDecision()`、`request()`、`run()`、`nativeApproval()` 已持有精确调用 Binding，并能等待原生审批服务完成。`finish()` 清理调用状态；会话缓存必须与该状态分离。
- `src/permission-controller.ts`：已有原生注册捕获、`tools/result`、`agent/disposed` 和 retire 生命周期。`src/core-permissions.ts` 的 runtime revoke 回调目前为空，接入记忆失效不能只修改测试 fixture 的回调。
- `src/permission-rules.ts`、`src/deployment-permission-rules.ts`：复用现有 refresh、source revision、同步状态和变更通知；不得新建配置 backend 或文件 watcher。

### 宿主最终审批 seam

已安装 `node_modules/@deepseek-ai/dsh-tools/lib/index.js` 的 `serviceAsk()` 将 `agent/toolName/callId/signal` 和 `displayReason` 对象交给 `approval.request()`，只有最终 `allowed-once` 转成 allow。已安装 `node_modules/@deepseek-ai/dsh-user-approval/lib/index.js` 的 `ApprovalService.request()` 在 `decide()` 后成功追加 `approval/decided` 才返回；`decide()` 在 waterfall 外处理 never、异常归一化和取消竞态。

因此 `approval/request` 监听器中的 `await next()` 不是最终批准 seam：外层 answerer 可改变结果，服务可取消，审计提交可失败。`displayReason` 身份可用于同次调用关联，但不能单独证明最终批准，reason 文本、日志中的“成功”、模型声称已获批准也不能证明。

采用 DSMM 所有的请求闭包：在现有 pre-execute/PermissionControl 路径创建 request，捕获调用及参与审批的 DSMM 规则，直接等待**原生服务的完整 `request()` 返回值**。这不替换服务、不补丁宿主，也不接管审批 UI/backend。此公开接口足以确认最终审批结果；调用绑定按下文的 generic guard 与 managed 既有入口分别重核。

## 配置与交付表面

新增 `guards.gitWriteScope: "all-writes" | "high-risk"`，默认 `"all-writes"`。新字段只限定自动 Git guard 的动作集合，与 `gitWriteGuard` 正交：

| 配置 | 自动 Git 行为 |
| --- | --- |
| all-writes + ask | 全部已知写入需要该规则的会话批准 |
| high-risk + ask | 仅下面定义的高危动作需要该规则的会话批准 |
| 任一 scope + deny | 拒绝该 scope 覆盖的自动 Git 动作，批准记忆不能覆盖 deny |
| 任一 scope + off | 不产生自动 Git 决策；其他显式规则和原生政策照常生效 |

`high-risk` 不过滤 `permissionControl.rules` 中的显式 shell ask/deny，也不关闭 nativeCommands 对象 ask；shell 方言安全、readonly 和其他现有 guard 不受影响。维持已有 native standing full-access/simple 路径的优先级，本字段不扩大其覆盖范围。

同步 `src/settings.ts` 的类型、默认值、schema/稀疏配置，`src/profiles.ts` 的严格校验，`src/profile-diagnostics.ts` 和 `src/child-capture.ts` 的合法字段树。新配置值可按既有配置规则被 child 捕获，**批准缓存不可捕获**。

通过现有 schema 驱动的 `src/client/DeploymentFields.tsx` 交付选择项，更新 `deployment-locales.ts` / `permission-locales.ts` 的中英文标签与必要提示，不设计新设置页。提示必须说明：仅缩小自动 Git 保护；规则批准仅在当前存活会话有效；原生提权和第三方审批可能仍出现。沿用全局/当前配置层、继承/恢复默认、保存与 readonly 禁用行为；不添加 live overlay Apply。

更新 `docs/safety-guards.md`、`docs/native-permissions.md`、`docs/deferred-native-approval-risk.md` 及确实涉及新字段的配置说明，描述最终行为。原生 once 不复用与 DSMM 规则记忆应明确区分，不保留“所有命令规则永不记忆”的失效描述。

## Git 分类与规则语义

### 结果模型

在 `shell-command.ts` 增加返回所有已知 Git 动作的纯评估入口。每项包含稳定内置 rule ID、动作名称、`write | high-risk` 风险，以及是否具备安全复用匹配的静态上下文。查询不产生写入项。去重后取所有适用规则，而不是只取最高风险或首项；compound 调用只有每一条适用 DSMM ask 都满足才免除 DSMM 询问。

可保留 `classifyKnownGitWrite()` 作为已有调用者的兼容投影；guard 使用完整集合。不要用 display reason、任意用户文本或整个 argv 作为内置规则 ID。普通提交与 amend、普通 push 与 force/delete、branch 创建与删除/强制覆盖必须是不同规则。

仅可执行文件名按现有 shell 平台规则比较；Git 子命令/选项按 Git 语义保留大小写，尤其 `-d/-D`、`-m/-M`、`-c/-C`。按命令专属语法消费选项值和 `--` 分隔符；提交消息、路径或值里的 `--force` 不算 force。支持已知短选项组合及 `--option=value`，不实现通用 shell 解释器。

### 混合读写命令的查询边界

| 命令 | 不触发写保护的已知查询 | 写入动作须细分 |
| --- | --- | --- |
| branch | 无参数列表；`--show-current`；`--list/-l` 及列表过滤/格式选项；仅 `-a/-r/-v/-vv` 的列表形式 | create、copy、rename、upstream/edit-description、delete、force-delete、force-update/force-copy/force-rename |
| remote | 无参数；`-v/--verbose`；show、get-url | add、rename、remove/rm、set-head、set-branches、set-url、update、prune |
| stash | list、show | 默认/push/save、apply、pop、branch、create/store、drop、clear |
| tag | 无参数；`--list/-l` 与查询过滤/格式；`--verify/-v` | create、delete、force-update |
| worktree | list | add、move、lock、unlock、repair、remove、prune |
| submodule | 无参数/status、summary | add、init、deinit、update、sync、set-branch、set-url；foreach 保持既有保守写判断，不解释嵌入命令 |

正确消费 query 选项的参数；存在明确修改动作时不因同时出现列表风格选项就将其视为查询。上述查询排除不得把原有真实写入漏掉。对混合命令中未能精确判定的形式维持 all-writes 的保守已知写保护，不生成可复用的动作批准。`git config` 的已知读/写形式、notes、replace、update-ref、symbolic-ref 同样产出具体动作，而非一个跨动作授权。

### 高危自动集合（封闭、仅 Git）

以下是本功能交付的完整集合；其他已知 Git 写入属于 all-writes，不因“可能危险”自动加入高危范围。表中语义开关均在选项位置识别，并覆盖 Git 对应的短/长形式。

| 高危动作/规则族 | 触发形式 |
| --- | --- |
| push.force / push.delete / push.mirror | `--force/-f`、`--force-with-lease[=…]`、`--force-if-includes` 或 `+` refspec；`--delete/-d` 或 `:dst` 删除 refspec；`--mirror`。三类独立；force-with-lease 不与无限制 force 共用批准键 |
| reset.hard | `reset --hard`；普通默认/mixed/soft/keep/merge reset 保持普通写分类 |
| clean.remove | 非 dry-run 的 clean，包括交互、`-f/-ff`、`-d/-x/-X`；`-n/--dry-run` 是查询，不产生删除批准 |
| branch.delete / branch.force-delete / branch.force-update / branch.force-copy / branch.force-rename | `-d/--delete`、`-D`、强制重置已有分支的 `-f/--force`，以及 `-C/-M` 或 copy/rename 配合 force；各动作分别记忆 |
| tag.delete / tag.force-update | `-d/--delete`、创建/覆盖模式的 `-f/--force` |
| commit.amend / rebase.rewrite | `commit --amend`；rebase 的启动与 continue/skip/abort/quit 等修改状态形式，按动作区分；帮助/显示当前 patch 不算改写 |
| stash.drop / stash.clear | drop、clear；pop/apply 仍为普通写，各自独立规则 |
| worktree.remove / worktree.prune | remove、prune；明确支持的 dry-run prune 作为查询 |
| checkout.discard / switch.discard / restore.worktree | checkout 的 force、路径恢复或 `-B`；switch 的 discard-changes/force 或 `-C`；restore 默认 worktree、显式 worktree 或同时 staged+worktree。仅 staged restore 为普通写；分支切换/创建与丢弃动作不共用键 |
| refs.modify | update-ref 写/删除、symbolic-ref 写/删除、replace 创建/编辑/删除/graft、reflog delete/expire/drop、filter-branch 历史改写；按子命令及动作独立键，查询形式不进入集合 |

`refs.modify` 只补全同一 Git 分类器内明确的引用/历史动作，不扩展 Shell 执行面。help/version 和可靠识别的 dry-run 形式不产生写批准；未知 dry-run 不能推断为安全。`git add`、普通 commit/push/fetch/pull/merge、branch/tag 创建等默认保护保持开启，在 high-risk 下仅免除自动 Git ask/deny；显式配置仍适用。

### 必须覆盖的复合命令

以下完整输入在 PowerShell 下不得出现 Git 写入判断：

```powershell
Get-Location; git status --short; git branch --show-current; git remote -v; git log -8 --oneline; git status -sb; Get-Command go,make,golangci-lint -ErrorAction SilentlyContinue | Select-Object Name,Source; go version
```

`git add .; git reset --hard HEAD`、`git commit -m x; git push --force origin main` 在 high-risk 下仍需高危批准；先批准普通写不覆盖后面的高危动作。同一调用含多个未批准动作时可合成一个 DSMM 提示，但应清楚列出规则范围，不能以首个动作代表整个调用。

## 存活会话批准与调用绑定

### 所有权与数据

提供一个 Core 生命周期内共享的内部记忆组件（可放独立 `src/command-approval.ts`），由 guards 与 PermissionControl 使用，而不是各自维护不一致的缓存。其存储形状为 `WeakMap<Agent, SessionRuleApprovals>`，并绑定实际 session 对象、owner/realm 和当前登记生命周期。generic 路径的注册身份取自当前可见 ToolRuntime 及其 definition 对象，不要求认证 native 模块来源。没有精确 Agent 或可绑定的实际注册对象时不记忆，也不新增放行。

每个缓存项保存已批准的**规则语义**：

- Git：内置动作 ID、风险/具体 force 语义、工具注册身份与 dialect、实际调用 cwd，以及影响 Git 目标的静态上下文（executable、`-C`、git-dir/work-tree、相关 env 包装）。参数中的分支名、提交消息等可以变化，不能越过动作/上下文边界。
- 显式 shell：rule ID、rule revision、action/revoked、完整 match；原规则只允许精确 command/cwd，记忆不能把它升级为前缀或参数通配规则。
- nativeCommands 对象：entry ID、mode、完整 match、sandboxMode 与当前来源代际；仍调用原 matcher 判断命中，不发明更宽语法或跨 cwd 复用。
- 多个同时匹配的 ask 必须全部满足；保留全部身份而非 `.map(rule => rule.action)` 后丢失 provenance。对象规则重叠时仍保留原有 sandboxMode 歧义处理，不能通过任一缓存项绕过。

使用结构化值/受信运行时代际比较，不另造摘要或持久化授权 token。配置来源更新、规则撤销/删除/同 ID 替换、模式或范围变化使关联记忆失效；可保守清空当前 owner 的全部命令记忆，不要求实现逐条差分。

Git 现有解析器不是授权级 shell AST。动态值、无法证明的 cwd/env 变化、未知动作不得得到宽松可复用命中；可继续按已有 guard 询问但不记忆该不确定项。复合命令中的记忆仅扣除已证明匹配的规则，绝不将整条 shell 调用直接改成 allow。不要用路径规范化宣称已经证明 executable 的物理身份或仓库 confinement。

### 一次调用的流程

1. 在现有 admission、readonly、注册/参数与规则 refresh 检查后，评估全部相关 DSMM 规则；deny 直接生效。缓存不代替任何检查。
2. 取得现有下游 decision；deny/cancel 原样返回。将 DSMM 规则贡献与未知来源的下游 ask 分开保存。
3. 从适用 DSMM ask 集合扣除有效缓存；不能从下游 ask 中扣除“看起来相同”的 reason。无剩余 DSMM ask 时继续原下游/native 路径。
4. 有剩余 ask 时，由 DSMM 创建 request 并通过现有原生 `approval.request()` 执行。闭包绑定精确 exec/token、agent、callId、arguments、注册对象、signal、参与的规则集合及来源代际。泛用 Git ask 即使没有 sandbox target，也走此最终结果路径；不依赖 target 存在才观察最终结果。
5. 已有同次调用合并审批可以保留：将下游 ask 和未满足 DSMM 规则一起展示，完整服务返回的批准仅消耗这一次下游要求；会话只记录其中明确属于 DSMM 的规则。之后独立产生的新 ask 必须重新询问。禁止通过 reason 字符串推断所有权或通过事件监听器抢答未知 request。
6. 仅最终返回 `allowed-once`、调用完整性仍成立、来源代际未变、Agent/session/owner 仍存活时写入规则记忆。拒绝、取消、unavailable、审计异常、伪造/被复制的关联信息均不产生记忆。缓存的是批准，不是工具成功结果；工具后续普通执行失败不凭空撤销批准，也不能凭成功结果补造批准。
7. `tools/result`/`finish` 清本次 pending/request 绑定和 native target；不清有效会话规则记忆。agent dispose、session 对象替换、owner/控制器退休清相应记忆。

缓存命中和首次批准的调用都登记临时绑定，与会话规则记忆分离。按原 exec 对象独立关联本次记录，不能只用可替换的 token 查表；token 改成另一有效调用的 token 也不能借用其 Binding。记录原 exec/token/arguments、agent/session、owner/realm、callId/name、实际 ToolRuntime/definition 注册身份和取消生命周期，并在完整审批返回及各路径已有检查点重核。

### Generic 与 managed 的检查边界

**Generic Git（包括普通 root、default stock 和 permissionControl disabled）：**在现有 pre-execute 路径评估规则并匹配会话批准，在原有 `tools.guard` 检查点重核本次绑定。当前可见 ToolRuntime/definition 必须仍与记录相同，arguments/token/agent/session/owner 及取消状态必须仍有效；可观察的不匹配直接阻断本次旧豁免，不因查不到被替换的 token 而落入无检查放行。下一次正常调用按自身身份重新评估；同一规则允许的参数变化只通过新调用重新匹配获得豁免，不允许修改已绑定调用的参数。

只有原生 `approval.request()` 完整返回 `allowed-once` 并通过当时的绑定/代际检查才记忆。缓存不得从模型输入、reason 文本、复制的 callId/token 或另一个 Agent/注册推导。该机制绑定实际注册对象，不需要认证它来自哪个 native 模块；默认 stock 可以直接使用，无需新 façade、包装 stock body、改角色注册、用户 profile 或宿主。

**Managed Shell：**完整保留 `PermissionControl.checkIntegrity()`、`run()`、`nativeApproval()` 及 simple stock wrapper 的既有检查和最终入口约束，不能因 generic 采用 guard 检查而降低 managed 强度。仍经过受控入口时，注册、body/schema、args/token 和生命周期不匹配必须在原 body 前拒绝；换成另一受控注册不能借旧 Binding。记忆只满足 DSMM 规则询问，不赋 `approvedTarget`/`mode`，不借 answerer 为新的 native 提权作答，独立 native/第三方 ask、deny 和取消继续生效。

**宿主信任边界：**`guards.ts` 的 generic Git 保护是 pre-execute ask 与既有 guard，并无最终 body 完整性保证。固定 DSH 的 `prepareExecution()` 执行 guard 后，`dispatchScheduledExecution()` 还会运行 `tools/execute` waterfall，随后 `dispatchToolBody()` 重新解析工具并读取 `exec.arguments`。generic 沿用这一可变 middleware 信任边界，不承诺阻止 guard 之后任意同进程插件的晚期替换；managed wrapper 也不承诺约束被替换成未受控 body 的执行。

从逐次询问改为会话规则记忆会减少人工介入，这是授权的产品变化，不能描述为总体风险完全不变。模型输入、不同 Agent/call/registration 不得通过正常规则匹配和审批接口借用缓存；拥有同进程权限并主动绕过管线、拆除检查或直接执行 OS 代码的插件，不属于 DSMM 的隔离保证。不为此增加最终钩子、signal 描述符机关、全局注册锁或新的 sandbox/provider 框架。

### 原生提权和策略竞态

`PermissionControl` 需要分开表示“DSMM ask 已满足”和“本次 sandbox target 已批准”。缓存命中不得直接赋值 `approvedTarget`、`mode`，不得以缓存为理由在 `answerer()` 中返回 `allowed-once`，也不能把 entry 的持久化 `mode: ask` 改写为 `allow`。

nativeCommands 的 DSMM ask 同样参与记忆，但如果该调用还需要 entry 所要求的 sandbox 提权或模型显式 `sandbox_permissions`，仍走当前原生 target 审批。第一次同次合并批准可依现有精确 Binding 消耗 target，后续调用不能复用该 once target。因而“不再重复 DSMM 规则询问”不等于“此后完全没有原生弹窗”；不能将 nativeCommands 的原生提权提示改个名字后宣称它被缓存消除了。测试应分别统计 DSMM 规则贡献和原生请求/目标。

具体区分无提权与有提权：已记忆的 entry 在没有显式 native 请求、所需模式不宽于实际 standing policy 时，不再创建仅为 DSMM ask 服务的合成请求，也不设置任何额外 mode；有实际 widening 时保留原生 target 请求。原有显式 `mode: allow` 与 simple 路径不在本次改写范围内，不能将它们的自动 answerer 捷径套用到新缓存。

所有新请求仍通过原服务的 never、审计、取消和 answerer 链。缓存查询也应检查当前原生 approval policy；切换为 never 不得靠旧缓存建立新豁免。任何未知来源下游 ask/deny 或工具体内独立 request 都不受缓存控制。

来源变化失效的是**未来缓存**：保持当前仓库“已等待的原生请求由最终操作员决定”的契约，不把规则 revision 更新变成第二次审批或强行取消原生 pending。旧请求若最终获准，仍仅按其原生单次契约执行，不向新代际缓存写入。新调用必须使用新规则。各路径检查点观察到取消、Agent/owner 销毁、注册替换或参数/token 不完整时，继续阻断当前调用；generic 不将此检查表述为 guard 后任意 middleware 的隔离保证。

`core-permissions.ts` 的真实 revoke 回调接入记忆失效；`PermissionControl.revokePolicy()` 不得因此撤销原生 pending 的物理生命周期。Git guard 在 `permissionControl.enabled=false` 时仍提供规则记忆：记忆组件、本次绑定及 guard 重核由 Core/guard 生命周期拥有，不依赖 native rule controller 已挂载，也不因此启用权限增强。普通 root/default stock 与 managed 都是交付范围，不能缩为 managed-only；只有缺失实际调用/注册身份或最终批准证据时才保持原 ask、不建立豁免。

## 实施责任与依赖

### A：Git 分类、动作身份与范围

负责 `shell-command.ts` 的全段评估、查询边界、封闭高危集合及纯测试；对外输出带 rule ID/风险/复用置信度的结果。结合新字段接入 `guards.ts` 的自动筛选，保留 guard 激活范围和既有 full/simple 策略。

完成证据：完整只读复合命令无写判断；六类混合命令的查询/修改对照；普通写默认仍询问；风险选项/`--`/参数值不混淆；复合命令后续高危不漏判，普通批准不覆盖高危。

### B：精确规则贡献、最终批准与会话记忆

负责共享内存组件及 `guards.ts`、`permission-native-rules.ts`、`permission-control.ts`、`permission-controller.ts`、`core-permissions.ts` / 必要 Core wiring。将规则身份保留到审批闭包，generic ask 使用完整服务返回 seam，以实际 ToolRuntime/definition 身份绑定豁免并在既有 guard 重核；保留 managed 最终入口及 simple stock wrapper 检查。清晰区分 DSMM 记忆与 native once target，接通真实规则失效与 Agent/owner 生命周期。generic 记忆不依赖权限增强开关，不需要新增角色 façade 或修改 stock 注册、用户 profile、宿主。

依赖 A 的动作接口；可先以显式规则完成内存/最终结果测试。集成点由同一负责人收敛，避免 guards 与 PermissionControl 相互提前批准或重复处理同一 DSMM 贡献。不修改原生 ApprovalService、ShellExecutor 后端或配置 backend。

完成证据：同 Agent 同规则参数变化免 DSMM 重问；新动作、新规则、child、恢复对象、规则更新重新问；最终外层拒绝/取消/审计失败不留下记忆；第三方新 ask/deny、readonly 和原生提权继续有效。普通 root/default stock 在 permissionControl enabled/disabled 下都实际减少 DSMM 询问，且既有检查点可观察的不匹配不能消费豁免；managed 仍有已有最终入口保护。仅 managed fixture 通过不代表完整交付。

### C：设置、profile 与现有 UI

负责新字段端到端交付、字段树及严格校验、中英说明和行为文档；依赖字段枚举及默认值，其他工作可与 A/B 并行。只更新现有组件，不新增前端框架/依赖或更换布局。

完成证据：缺省 all-writes；high-risk 保存/载入/继承正确；非法值拒绝；全局和 profile 的字段树未遗漏；只读界面不能保存；child 可接收设置但无父批准缓存。真实界面操作一次选择、保存、恢复继承并观察实际 guard 行为；没有可用浏览器时明确保留该项未验证，不以静态文案断言替代。

## 验证与验收

优先扩展现有测试：`test/shell-command.test.ts`、`guards.test.ts`、`permission-managed-shell.test.ts`、`permission-native-rules.test.ts`、`permission-control.test.ts`、`permission-native-command.test.ts` 及对应 settings/profile/client 测试。新增测试文件仅在共享记忆组件需要独立稳定 seam 时使用。

重点集成场景：

- 完整原始只读输入，以及 ordinary→high-risk 的 compound 输入；内置 branch/tag 的创建批准不覆盖删除、强制更新。
- 显式 shell ask 在 high-risk 模式仍问；精确 command 改参不命中旧规则。nativeCommands 对象改参仍按原规则命中，但新 cwd/tool/规则语义不继承批准。
- 同调用包含多个 DSMM 规则；已有缓存只消除其覆盖部分，新匹配 ask 仍显示，任何 deny 仍拒绝。
- generic Git 无 target 请求的最终 allow/reject；内层允许后外层拒绝、取消竞态、approval/decided 提交失败均不记忆。外层最终 allowed-once 只能依据完整服务返回处理，不能依据中途返回。
- 源变更发生在 pending 期间：当前 native once 保持既有契约，新规则绝不获得旧批准；A→B→A 更新不能恢复旧缓存。
- 父/child/兄弟、不同 Agent 对象但相同 session ID、Agent dispose/recreate、控制器退休互不继承。并发同规则未决请求不互相借用尚未完成的批准；无需引入请求队列或 single-flight 子系统。
- generic 在审批返回或既有 guard 重核前发生可观察的 arguments/token/注册、Agent/session/owner 变化时，不得消费旧豁免；以另一 pending call 的有效 token、相同 callId 或同名新 definition 冒用也必须拒绝。模型输出“已批准”、复制 reason/displayReason 均不能建立记忆。正常的新调用必须重新匹配自己的规则与注册，不得借其他 Agent/call 的临时 Binding。
- managed 保留最终入口回归：将变更放在 `tools.guard` **之后**的 `tools/execute` waterfall，换 arguments/token 或装入另一受控注册，仍经过 managed 入口时原 body/计数 Shell 必须零启动；保留原 body/schema 检查及 simple stock wrapper 覆盖。测试不靠最后注册监听器制造终点，正常 signal 替换、调用者取消融合与清理继续可用。这不是 generic 的 guard 后绝对验收，也不承诺拦截已被替换成未受控 body 的执行。
- 缓存命中之后的第三方 pre-execute ask/deny、工具体独立请求、never、readonly 仍生效；sandbox mode 不从会话缓存继承，不改变 OS 访问能力。
- 普通 root/default native Shell 使用原生 `Native.apply()` 加计数 Shell 验证，permissionControl enabled/disabled 都可首次批准后按规则免 DSMM 重问，新注册/规则仍重新询问，独立 ask/deny、readonly、never 和取消仍有效；无需新增 stock wrapper 或认证 native 来源。正常 full-access/simple 路径不因新字段扩建拦截。

本地检查从 dsmm 根目录运行，已构建输入有实质变化时才重建。源导入测试沿用 `--experimental-strip-types --import ./test/prompt-source-loader.mjs`；引用 `lib/` 的分类/guard 测试必须使用当前构建，不能拿旧产物当新实现证据。

```powershell
pnpm run typecheck
pnpm run build
node --test --experimental-strip-types --import ./test/prompt-source-loader.mjs --test-concurrency=1 test/shell-command.test.ts test/guards.test.ts test/permission-control.test.ts test/permission-managed-shell.test.ts test/permission-native-rules.test.ts test/permission-native-command.test.ts
```

执行者使用相关轻量检查；主协调者在集成完成后合并一次必要的全局检查，复用仍覆盖当前接口的通过证据，不为每个分块重复全套。没有 release/pack 要求；不运行发布完成检查。测试需使用现有隔离 DSH 环境、内存审批服务和计数 Shell，关闭 fixture 并删除其自有临时文件，不触及用户配置。

不添加文档/提示词/错误文案全文锁、包版本或本机路径快照、缓存不存在性检查等仪式测试；断言匹配、审批次数及归属、执行/拒绝、生命周期与 sandbox 边界。

## 风险与交付判定

- 静态 Git 识别是有限提示保护，不是 alias/任意 shell/真实仓库隔离的安全保证；无法确定的语法不得获得更宽记忆。
- 原生沙箱提权仍可能每次弹窗，这是“不复用 native once”的边界，UI/文档与测试必须可区分 DSMM 重问和独立 native 请求。
- 动作分类与缓存 provenance 是核心安全风险：不能只有高危正例，没有混合动作、值解析、规则变更与外层拒绝测试。
- generic 的完整审批结果与既有 guard 重核足以实现规则记忆，默认 stock 无需新增 attachment seam；managed 继续使用已有最终入口。generic 遵循宿主可变 middleware 信任边界，不保证 guard 之后任意同进程插件无法替换执行。减少逐次人工介入是本功能的风险变化，必须如实说明；不能将其宣传为 OS 或任意插件隔离。
- 完成条件是 A/B/C 全部可用且上述边界获得行为证据；单独修复 branch 误报、只交付配置或只缓存 nativeCommands 都不构成完整交付。
