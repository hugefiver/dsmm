# Idle session Profile switching

## 交付目标与约束

支持已经执行过、当前真正 quiescent 的原生 root 会话原位切换 DSMM Profile，包括完成原生恢复并重新 admission 的 root；blank 仍受支持，但不再是唯一目标。切换成功后，同一个 Agent 的下一次实际请求使用新 admission、prompt、技能和角色配置，后续新委派使用新角色路由。UI 在真实活动结束后刷新服务端能力，不再因存在历史而永久禁用并要求新建。

- DSMM 保持 `0.3.14`，DSH 保持 `0.2.1-rc.2`；仅使用本 checkout 和已安装的公开原生接口。不得升级、安装、修改依赖或私有 patch、操作用户 Host、执行 Git 写操作。
- 不以新建、重启、cancel/interrupt/drain、清历史、清 inbox 或迁移草稿实现切换。保留原生 session/Agent identity、历史、draft/附件、native preset、mode intent 和 native model selection。
- 普通 root 的 native model selection 与 Profile 独立；选择 Profile 不调用 model selector，不把 Profile primary 强塞给普通 root。显式“Use profile model”保留原语义。未来会话默认 Profile 不被修改。
- 权限、审批、read-only/tool/depth ceilings、operator/connection/carrier 身份与持久化 CAS 不得弱化。切换不继承旧 admission 的授权 memory，不把 profile 内容或会话日志当作许可。
- 保留 no-session Profile 和 sticky bars 行为；其需求见 `2026-10-23-profile-selection-and-form-actions.md`。不改用户未跟踪的 `2026-10-22-profiles-page-redesign.md`。原生命令自动授权模式修复属于 roadmap 的后续观察项，不在本次交付范围。
- `ProfilesSection.tsx`、`ProfileModelsDialog.tsx`、`DeploymentPage.tsx`、`PermissionsPanel.tsx`、`styles.ts` 等顶部 bars 文件不在本任务写入范围。保持现有命令权限配置和原生工具加载兼容性；配置切换所需的 exact-Agent memory 失效单独保留。

## 关键接口与可依赖事实

| 接口 | 已知契约及本任务用途 |
| --- | --- |
| `src/native-admission.ts` 的 `blankReason` / `beginBlank` | 现有事务已包含 exact live binding、依赖身份、selecting gate、候选预安装和恢复。将其配置切换资格推广为 quiescent root；原生 preset recomposition 的 `rebindBlank` 不跟随放宽。 |
| `src/profile-runtime.ts` 的 `sessionActions` / `selectSession` | 统一 capability 与提交判断，去掉仅因 history admission/started/seeded 而拒绝的条件；保留真实 root、trusted live admission 和 authority。不能只改 UI 或删历史判断。 |
| 原生 `Agent.runMaintenance` | `dsh-agent/lib/types/runtime-types.d.ts:159–174`：同步占用 true idle，公开 status 仍是 idle；后来 waking input 等待维护结束；驱动或其他维护已占用时拒绝。`whenIdle()` 和 status 读取不是 reservation。 |
| 原生 subagent runtime | `waitForChildren` 不是锁；`drainChildren` / `drainDescendants` 会释放/停止活动，不能用于切换。公开接口没有整棵子树的配置维护事务；root maintenance 不保证子 Agent 静止。 |
| `src/profile-store.ts:225–275` | `selectSession` 校验 selection revision、profile source revision，预安装后 atomic replace，再同步发布 admission。继续复用，不另建持久化格式或事务系统。 |
| `src/index.ts:145–162` | installer 的稳定 getter 经 `NativeAdmission.configuration()` 读取 candidate/live admission。重新安装 prompt、skills、headless role tools；model/safety hooks 已安装一次，并在请求时读 getter。不得重复注册 hook。 |
| `src/model-routing.ts:39–103` / `src/role-routing.ts` | request 读取当前 settings/epoch；role-policy identity 包含 epoch；普通 root 返回原生 proposal，子角色 invocation 使用自己的 captured route。切换后必须验证实际请求，不以菜单或 snapshot 代替。 |
| `src/core-permission-authority.ts:102–169` / `src/guards.ts:281–318` / `src/command-approval.ts` | Core generation 感知 admission/parent authority；generic guard memory 的 source 感知 admission 对象。memory 也可能绑定相同 Agent、definition、ownerGeneration，不能仅假设换 epoch 会清除所有父子 memory。 |

### Known identity 与观测边界

“可安全切换”必须由本进程原生事实推导：exact Agent 在同一 registry 的身份、exact Session/header、真实 root 集合、scope/preset/service/provider identity、当前 NativeAdmission owner/lifetime、当前 admission epoch，以及原生 direct-parent ownership。字符串 session ID、UI idle、历史 descriptor、catalog 的 inactive、成功日志均不能单独证明这些事实。

资格观测至少包括：root/相关 resident descendants 的 status、两类 inbox、未闭合 turn、维护占用的最终 reservation、NativeAdmission pending creation/calls、真实 tool execution 到 result 的生命周期，以及原生 approval 的未结束请求。原生 approval 要求 open turn；使用该保证时同时验证真实 turn/driver 边界，不能仅以没有 DSMM tool token 推断没有 native pending work。对绕过 turn 的公开 tools.execute 路径保留 execution 跟踪，覆盖 pre-execute/approval 等待和 result/失败清理。

不读取 manager 私有字段来补观测。已知受控 creation/resume 必须继续经过 awaited `agent/created` admission、parent identity 检查和 execution gates。缺少完整 binding、activity 或 maintenance 证明的 foreign/external 分支保持不可用并报告具体限制；不能把“所有有 child 的会话”一概永久禁用。

## 服务端设计

### 1. 单一资格判断与原生维护事务

以 quiescent 配置切换 eligibility 替代 blank-only eligibility，供 `sessionActions` 和实际 mutation 共用。资格要求：exact admitted root、依赖/owner/lifetime 未变、无 open turn、无既有 queued input、无 pending execution/approval/creation/call，且可取得原生维护 reservation。历史存在或已完成 child 不构成 busy。

提交继续沿用 `selectSession` → `runMaintenance` → admission transaction → store CAS/prepare/install → atomic commit/publication → close。每个 await 后和 commit 前重检 authority、对象身份、epoch、依赖与相关子树；客户端请求过期、连接/owner 换代、preset 变更、取消都不能提交。

`canApplyOverlay` 是可刷新观测，不是预留许可。公开 status 不暴露其他 maintenance 的真实 phase；实际 `runMaintenance` 拒绝仍为权威结果，不伪造客户端锁或轮询 phase 私有字段。

### 2. 已完成但仍 resident 的子树

对 exact owned、已 admission 的 resident 子树，使用各 Agent 自己的公开 `runMaintenance` 组成短期屏障：在开始异步 preflight/install 前取得 root 及相关 descendants 的 reservation，稳定顺序取得，任一占用/运行/queued/open-turn/未知分支即释放本事务已经取得的 reservation 并拒绝。只能释放本事务的等待门，不 cancel Agent。

- 维护期间保持原有 parent/child admission、scope、invocation 和 captured ceilings。只替换 root admission；不重绑已有 child 到新 Profile，不把新父权限授予已有 child。新委派在 commit 后捕获新 root admission。
- child 在 reservation 前已有工作应拒绝；reservation 后经原生入口接受的新输入留在其 inbox，等所有相关 publication/rollback 完成后才释放。root 的后来输入使用新 admission（失败恢复则用旧 admission）；已有 child 的后来输入继续其原 captured admission，并受当前原生 lineage/authority 与既有 ceilings 约束。
- 预留时及 commit 前确认完整 exact descendant 集合、ownership、依赖和 pending creation 没有变化。新 materialization 在 selecting/creation 检查处 fail closed，不能发布半更新 child。无需载入、唤醒或释放纯历史/nonresident child。
- 原生公有 API 没有 subtree-wide admission lock。实施必须用真实 native fixture 证明：resident child 的 queue/steer、cold resume/startup 和外部直接 execution 不能跨过屏障执行或获得错误 admission。无法证明的具体 provider/ownership 分支应明确不可用并交主代理；不得通过忽略 child、终止 child、猴子补丁或永久封禁所有 resident child“解决”。

### 3. Epoch、持久化及恢复

每次成功切换发布一个新的 live epoch；请求继续携带 `expectedAdmissionEpoch`、`expectedSelectionRevision`、`expectedRevision`。三者分别约束当前进程 admission、会话选择指针及目标 Profile 源文件，不能相互替代。

普通恢复由 `prepareActivation` 产生 fresh live epoch，并用 `sessionObservations` 绑定所读磁盘 revision。恢复后用户可对这个新 epoch 正常切换；不要求 live epoch 与旧磁盘 epoch 相同，不重新信任旧授权。旧窗口/旧 Agent 的 epoch 必须失败。显式 history admission 若确实发布为可信 live root，同样用当前 disk selection revision 作 CAS；history 标记本身既非永久拒绝原因，也非绕过 CAS 的许可。

保持 store 的 prepare/atomic publication 顺序：安装失败或 CAS/authority 失败时恢复原 prompt/skills/tool definitions/admission；恢复失败保留既有 fail-closed execution guard。durable commit 后 observation 不确定返回既有 refresh-required 语义，不能假称 rollback 或自动重试 mutation。历史/消息/草稿不作为事务写入目标。

### 4. 下一次请求与授权 memory

保留 installer 的稳定 getter/候选预览机制；新 admission 发布后，新请求的 Core capture、prompt assembly、角色工具可见性、guard settings、model parameter policy 和 recovery policy identity 均来自新配置。按 epoch 分隔旧 route/recovery 状态，不能复用旧 admission 的恢复提案。验证失败恢复同样适用于已执行 root，不仅是 blank。

普通 root 的 native model/options、显式 model intent 与 Deepwork mode intent原位保留；Profile 只改变其负责的配置。验证角色模型变化通过新委派实际 provider request；root 验证新 admission/prompt/参数策略与原生 model 未被替换。

在成功 publication 边界确保受影响 exact root/驻留子树的旧 DSMM command-rule memory 不跨配置事务复用；失败事务不清有效 memory，不全局影响其他 root。优先复用现有 admission source/authority generation，补足未覆盖的 memory 路径时，在 `command-approval.ts` 增加精确 Agent 的非 retirement 失效接口，并由 Core/installer 所有者在同步 commit 边界调用。不得调用 `revokeAgent`（会永久退休 Agent）、全局 `invalidate` 或改 permission worker 的 mode-gating 文件。失效必须阻止迟到旧 binding 重新写入 memory，不能终止或推翻已获人工 once 的原调用；pending 调用本就应阻止切换。

原生 once outcome 仍只属于其调用；不清原生权限配置、不把 native standing mode 改成 Profile 字段。父切换不能把父 memory 复制给 child；恢复的 Agent 不恢复旧进程 memory。既有 child 保留 captured read-only/tool/depth ceilings，不能因父 Profile 更宽而获得新增权限。

## 客户端与协议

保留 `describeSession` / `selectSession` 与现有 snapshot 的 `canApplyOverlay`、`applyOverlayUnavailableReason`、epoch/revision 协议。使用已有 busy/maintenance/runtime-unavailable/conflict 分类；无必要不增加 RPC 字段。

`src/client/controller.ts`、`src/client/index.ts` 订阅当前 `SessionBinding.session` 的公开 `getSnapshot()/subscribe()`，在 `SessionSnapshot.running` 转换时合并触发只读 snapshot refresh。原生 running 只用于触发刷新，是否真正 quiescent 仍由服务端能力决定；`settle-assistant` 不是 driver 已退出的证明，不能在本地直接令 canApplyOverlay=true。保留已有 mode/preset 事件刷新，避免逐个流式事件请求 describe。

刷新受 connection/session/binding/request generation 约束；迟到响应不能覆盖新导航或成功 mutation。busy/maintenance/conflict 后重新读取，不自动重试选择。保留 no-session 准备流程和已有 draft/dirty-editor/pending mutation 状态，不因刷新清空 Profile editor、composer 或附件。不改顶部 bars 布局；`SessionProfiles` 继续消费服务端能力，必要的不可用原因呈现只做局部调整。

## 最小分工与完成证据

### 服务端 worker：安全切换及真实请求

主要范围：`native-admission.ts`、`profile-runtime.ts`，必要时 `profile-store.ts`、Core `index.ts` / `command-approval.ts` 和直接相关 routing seams；测试主要放入 `session-profile-runtime.test.ts`、`native-profile-apply.test.ts`、既有 permission/command-approval fixture。不写客户端或权限 worker 独占文件。

实施前先加一个窄失败回归：真实 native fixture root 在 A 下执行并完全 idle，切换 B，再在同一 Agent 执行下一请求；观察 provider request/prompt 和后续角色委派，而非仅断言 snapshot。将旧测试中“已执行/seeded/有已完成 child 必须新建”的断言更新为新要求，保留原有 busy、CAS、ownership 和失败恢复覆盖。

有意义的验收重点：

- A → B → baseline；当前 root 与持久化恢复 root；下一实际请求采用新配置/epoch，global default、native model、session identity、历史及输入保留。
- 完成且 resident 的 continuable child 不永久阻塞；运行 child、后代运行、已有 queued input、pending creation、turn 外 native tool、approval 等待、其他 maintenance 均安全拒绝。queued-during-maintenance 按上述成功/失败语义执行。
- 维护期间 queue/steer/cold resume、dependency/owner/preset 变化、旧 epoch、磁盘 revision 冲突、operator/connection 撤销：无半更新和权限提升。
- preflight/install/atomic-write 故障恢复旧实际 prompt/tool 行为；恢复失败阻止执行；已提交但读取不确定不报虚假未提交。
- 同 Agent 同 command 在切换前形成 memory，成功切换后需新的真实批准；失败切换不损失旧有效 memory；其他 root 不受影响；已有 child 和恢复 child 不继承父/旧进程 memory，ceilings 不扩大。保留人工 native once 与权限 mode-gating 已有行为。

### 客户端 worker：能力刷新

只负责 `client/controller.ts`、`client/index.ts` 与针对性的 controller/session-selection 测试。依赖公开 Session snapshot 订阅与服务端 snapshot 合约，可和服务端并行，集成时验证 running/settlement/idle、同 session 更新、导航/重连迟到响应及 mutation 中刷新，不重做 no-session 或 bars。

### 集成验证

worker 运行受影响单文件轻量测试；主代理协调当前源的 build/typecheck 与相关模块合并验证，不运行 diagnostic/all。单文件沿用仓库 runner 的参数，例如：

```powershell
node --test --experimental-strip-types --import ./test/prompt-source-loader.mjs --test-concurrency=1 test/session-profile-runtime.test.ts
pnpm run typecheck
pnpm run build
pnpm run test:module -- config-profiles routing-model native-runtime permissions frontend-package
```

按最终实际改动缩减不相关模块，保留被触及的安全边界；需要构建产物的 fixture 必须来自当前源。真实模块 Host fixture 与原生 Gateway/cross-VM RPC 是可用验收面；新 native 回归不依赖用户 Host 或下载。

原生 Host/浏览器集成按 `docs/testing.md` 对应 `native-runtime` / `frontend` 组记录可运行覆盖。当前外部 Host/Playwright anchors 缺失，browser UI、实际部署 Host 的订阅行为仍为 **unverified**；不安装、不访问用户 Host、不把 skip 或 VM/controller 测试宣称为浏览器通过。

## 实质限制与交付判定

可复用的公开维护原语足以规划单 root 的原位事务；resident 子树的组合屏障及 native pending-work 完整观测需要上述真实并发回归证明。若某分支没有精确 activity/reservation/creation 身份证据，记录其 provider/入口与缺失的公开保证并保持拒绝，不以私有实现或取消任务扩展权限。

完成证据包括当前源中已执行 root 的下一实际请求、resident child 安全性、epoch/CAS、memory 隔离和客户端能力刷新；缺失真实浏览器锚点单独如实报告。focused safety review 与最终验收由主代理负责。
