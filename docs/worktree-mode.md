# Worktree 模式设计

状态:已实现(未发布)。与设计的差异:`.prometheus/worktree.json` 目前只支持 `link` / `copy`,`setup` 命令、保留天数提醒、自动化接入(自动化不走隔离,与 §7 默认一致)尚未做。

## 1. 目标与非目标

目标:项目内每个对话可以拥有独立的 git 工作树。agent 在工作树里改代码,真实项目目录在用户点"合并"之前一个字节都不会变。同一个项目可以同时开多个会话,互不干扰。

要求这个模式可以关闭:全局、按项目、按单个新会话都能关。

非目标(v1 不做):
- 非 git 目录的隔离(见 §9)。
- 阻止 agent 用 bash 主动操作工作树以外的路径。这是路径级的软隔离,不是沙箱(见 §6)。
- 隔离端口、数据库、外部服务这类运行时资源。

## 2. 三层开关

| 层级 | 位置 | 取值 | 作用 |
|---|---|---|---|
| 全局 | `HostSettings.worktreeMode` | `off` / `ask` / `on` | 新会话的默认行为。`ask` 表示新会话输入框旁显示开关,默认值由 `worktreeDefault` 决定 |
| 项目 | `WorkspaceInfo.worktree?: "inherit" \| "off" \| "on"` | 默认 `inherit` | 覆盖全局设置 |
| 会话 | 新建会话时的开关 | 开 / 关 | 只在创建时可选;已创建的会话不能中途切换 |

第三层不允许中途切换:从非隔离切到隔离,历史上下文里的绝对路径会全部指向旧目录。已有会话想隔离,就新开一个。

默认值建议:`ask`,默认开启。`off` 时行为与现在完全一致,没有任何新代码路径被触发。

## 3. 数据模型

会话元数据新增(存在会话索引里,不放进 PI 的会话文件):

```ts
interface SessionWorktree {
  root: string;          // 真实项目目录(主工作树)
  path: string;          // 本会话的工作树目录,也是 session.cwd
  branch: string;        // prometheus/<slug>-<短id>
  baseBranch: string;    // 创建时主目录所在分支
  baseCommit: string;    // 创建时的提交,用来算 "本会话改了什么"
  state: "active" | "merged" | "discarded" | "orphaned";
  mergedAt?: string;
}
```

`SessionSummary` 增加可选字段 `worktree?: SessionWorktree`,旧服务端缺省即视为非隔离。

存放位置:`<dataDir>/worktrees/<workspaceId>/<sessionId>/`。放在项目目录之外,理由:不污染项目、不会被项目的 `.gitignore` 或扫描工具误伤、删除项目时不会连带丢失。代价是路径较长,Windows 上要注意 260 字符限制,所以目录名用短 id。

### 关键耦合点:workspaceId 现在由 cwd 推导

`workspaces.ts` 里 `workspaceId(path)` 是路径的哈希,会话归属项目靠 `session.cwd` 反推。工作树 cwd 不同,会话会被识别成新项目,**侧栏里出现一堆假项目**。这是整个方案最容易出问题的地方,必须先改:会话有 `worktree.root` 时,归属以 `root` 为准。要排查所有 `workspaceId(cwd)` 调用点(`session.create`、会话列表、自动化、同步外部 agent 会话等)。

## 4. 生命周期

### 4.1 创建

`session.create` 在 `cwd` 属于 git 仓库且开关为开时:

1. 校验:是 git 仓库、至少有一次提交、`git worktree` 可用。不满足就降级为普通会话,并在会话里提示原因,不能静默。
2. 取主目录当前分支和 HEAD,记为 `baseBranch` / `baseCommit`。
3. `git worktree add -b prometheus/<slug>-<id> <path> <baseCommit>`。
4. 处理主目录的未提交改动(见 §4.2)。
5. 处理未被 git 跟踪的必要文件(见 §4.3)。
6. 把 `session.cwd` 设为工作树路径,写入 `worktree` 元数据。

创建失败要回滚:删掉半成品目录和分支,再降级。

### 4.2 主目录有未提交改动

默认:工作树从 HEAD 开始,**不带**未提交改动。会话顶部提示"主目录有 N 个未提交文件,本会话看不到"。

可选(创建时勾选"带上当前改动"):用 `git stash create` 得到快照对象,在工作树里 `git stash apply`。不用 `git stash push`,避免动主目录的状态。

### 4.3 node_modules、.env 等未跟踪文件

新工作树里没有这些,项目直接跑不起来。方案:

- 项目根放 `.prometheus/worktree.json`(可选):
  ```json
  { "link": ["node_modules"], "copy": [".env", ".env.local"], "setup": "pnpm install --offline" }
  ```
- 没配置时的默认:对 `node_modules` 建链接(Windows 用 junction,免管理员权限),`.env*` 复制。
- `link` 的坑要写进文档:链接的目录在两边是同一份,在工作树里装依赖会改到主目录的 `node_modules`。需要独立依赖的项目应该用 `setup` 而不是 `link`。
- `setup` 命令在工作树里异步执行,会话界面显示进度,失败不阻塞会话,只给警告。

### 4.4 进行中

- 每轮结束后自动做一次 checkpoint 提交(`wip: <首句摘要>`),只提交到会话分支。作用:diff 稳定、可回退到任意一轮、崩溃不丢改动。合并时会被压缩,不会进入主历史。
- 如果项目有 pre-commit hook,checkpoint 用 `--no-verify`,合并时再按用户选择决定是否跑 hook。
- 会话恢复时发现工作树目录不存在(被手动删了):用分支重新 `worktree add`;分支也没了则标记 `orphaned`,提示用户。

### 4.5 结束

三种终态:

| 操作 | 效果 |
|---|---|
| 合并 | 见 §5。成功后默认删除工作树和分支,会话保留为历史 |
| 丢弃 | 删除工作树和分支。有未合并的提交时需要二次确认,确认框列出文件数和提交数 |
| 保留 | 什么都不做。会话归档时如果还有未合并改动,弹窗问"合并 / 丢弃 / 保留"。保留的分支超过 N 天(可配置,默认 30)在启动时提示清理 |

启动时执行 `git worktree prune`,并扫描 `<dataDir>/worktrees` 找孤儿目录。

## 5. 合并(核心安全流程)

原则:**真实目录永远不进入冲突状态**。冲突在工作树里解决,主目录只做无冲突的快进。

流程:

1. **预检**(合并按钮点击时,以及面板打开时轮询):
   - 主目录当前分支是否仍是 `baseBranch`。不是则提示切回去,或改为合并到用户选定的目标分支。
   - 主目录是否有会被覆盖的未提交改动。算法:会话分支相对 `baseCommit` 改的文件集合,与主目录 `git status` 的文件集合求交。有交集就阻止,并列出文件;没有交集允许继续。
   - 会话是否正在运行。运行中不允许合并,先让用户停止。
2. **同步**:在工作树里 `git merge <baseBranch>`(或 rebase,可配置)。
   - 无冲突:进入第 3 步。
   - 有冲突:停在工作树里,会话收到一条系统消息"合并 base 分支时有冲突:文件列表",用户可以点"让 agent 解决"。解决并提交后重新预检。**主目录没有被碰过。**
3. **落地**:此时会话分支已经包含 `baseBranch` 的全部内容,主目录合并必然是快进或无冲突。按用户选的策略执行:
   - `squash`(默认):`git merge --squash`,一个提交,提交信息由 agent 起草、用户可改。
   - `merge`:保留 checkpoint 历史,`--no-ff`。
   - `apply`:只把改动落到主目录工作区,不提交,让用户自己提交。
4. **清理**:按设置删除工作树和分支,状态置为 `merged`。

同一项目的合并操作加互斥锁,多个会话同时点合并时排队;后一个会话在预检时会发现 base 已前进,自动走第 2 步同步。

合并失败的任何一步都不留半成品:主目录用 `git merge --abort` / `git reset --merge` 恢复,并把错误原文展示出来。

### 多会话重叠提示

面板里显示"与会话 X 改了相同文件:a.ts、b.ts"。这只是提示,不阻止合并。算法就是各会话相对各自 `baseCommit` 的改动文件集求交。

## 6. 隔离强度:能保证什么,不能保证什么

能保证:
- `session.cwd` 是工作树,PI 的 `isProjectPath(path, cwd)`、`acceptEdits` 的路径边界、各 runtime 的默认工作目录都会自动指向工作树。
- 权限闸(`permission-gate.ts`)新增一条规则:会话有 `worktree` 时,任何写类工具的目标路径如果落在 `worktree.root` 内(且不在工作树内),直接拒绝并告诉 agent "请改用工作树内的相对路径"。这解决的是 agent 从上下文、记忆里拿到真实目录的绝对路径后误写的情况。

不能保证:
- bash 里 `cd` 到别处、或者用脚本写绝对路径。规则只能做命令文本的启发式检查,绕得过去。要强隔离需要沙箱,不在 v1 范围。文档里要明说,不要夸大。
- 记忆、知识库、历史会话里出现的真实目录路径:系统提示里要加一句"你的工作目录是 <path>,不要使用其他项目路径"。
- 开发服务器端口冲突、共享数据库、共享缓存目录。

## 7. 与其他功能的关系

| 功能 | 处理 |
|---|---|
| 子智能体 | 继承父会话的 cwd,即同一个工作树,不再单独建 |
| 自动化 / 流程(无人值守) | 默认**关闭**隔离,保持现状;任务配置里可以单独打开,打开后任务结束不自动合并,产生一条待审核记录 |
| 宠物委派(`pet_delegate`) | 跟随委派目标项目的设置,委派的 run 是一个普通会话 |
| Claude Code / Codex / OpenCode runtime | 只依赖 cwd,同样有效。它们自带的会话存储里记录的是工作树路径,同步外部会话时要用 §3 的归属规则 |
| Git 面板(`GitView`) | 在工作树会话里,面板操作的对象是工作树。已有的 `rangeFiles(base)` / `rangeDiff` 可直接用来展示"相对 baseCommit 的改动",不用新写 diff 引擎 |
| 技能、知识库、memory | 不受影响 |
| 文件树、打开文件 | 路径以会话 cwd 为根,自然指向工作树 |

## 8. 协议与界面

### 协议(`packages/protocol`)

- `HostSettings`:`worktreeMode?`、`worktreeDefault?`、`worktreeMergeStrategy?`、`worktreeKeepDays?`
- `WorkspaceInfo`:`worktree?`
- `SessionSummary`:`worktree?`
- `session.create` params:`worktree?: boolean`(缺省按设置)
- 新 RPC:
  - `worktree.status { sessionId }`:返回 ahead/behind、改动文件数、与主目录冲突的文件、与其他会话重叠的文件、可否合并及原因
  - `worktree.sync { sessionId }`:把 base 并入工作树
  - `worktree.merge { sessionId, strategy, message?, cleanup }`
  - `worktree.discard { sessionId }`
  - `worktree.pending { workspaceId }`:该项目所有未合并的工作树,给侧栏和清理提示用
- 新事件:`worktree.changed`(状态变化,驱动徽标刷新)

错误走现有的 `AppError(code, params)`,新增 `worktreeNotGit`、`worktreeNoCommit`、`worktreeBaseMoved`、`worktreeMainDirty`、`worktreeConflict`、`worktreeBusy`。

远程感知:`worktree.status` 会对基础分支的 upstream 做一次节流的 `git fetch`(30 秒一次,合并前强制刷新),返回 `remote { ref, behind, landed, overlap }`。若远程已包含本对话的全部改动(`landed`,例如 PR 已在远程合并而本地未 pull),或远程改了同样的文件(`overlap`),合并被拦下并提示先在项目文件夹 pull,新增 `worktreeLanded`、`worktreeRemoteMoved`。无 upstream 或离线时跳过检查。

### 界面

- 设置页:全局模式三选一、默认策略、保留天数,以及每个项目的覆盖项。
- 新会话输入框旁:"隔离工作树"开关,颜色跟随主题色。关闭时不显示任何额外元素。
- 会话头部:分支徽标 + "N 个文件 · 领先 M · 落后 K",点击打开审核面板。
- 审核面板:文件列表和 diff(复用 `GitView`),底部三个按钮:合并 / 丢弃 / 让 agent 先整理。预检失败时按钮置灰并写明原因,不能只置灰。
- 侧栏:有未合并工作树的会话显示小圆点。

## 9. 边界情况

| 情况 | 处理 |
|---|---|
| 目录不是 git 仓库 | 降级为普通会话并提示。可选:提供"先 git init 并做初始提交"的按钮,需要用户点击,不自动执行 |
| 仓库没有任何提交 | 同上,降级并提示 |
| 子模块 | v1 不处理,工作树里子模块目录是空的;检测到 `.gitmodules` 时给出警告 |
| Git LFS | 依赖用户本机配置,不额外处理 |
| 主目录是 monorepo 子目录 | cwd 在仓库子目录时,工作树里的 cwd 要对应到同样的相对子目录,不是仓库根 |
| 路径过长(Windows) | 目录名只用短 id;创建失败时给出明确提示 |
| 在远程/Docker 部署的服务端 | 行为一致,数据目录在服务端;磁盘占用提示放进设置页 |
| 同一分支被主目录签出 | 会话分支是新建的,不会冲突 |
| 磁盘占用 | 每个工作树是一份完整检出。设置页显示总占用并提供一键清理已完成的 |

## 10. 实现分期

1. **基础**:`packages/core/src/worktree.ts`(创建、删除、状态、预检),会话元数据,workspaceId 归属改造,设置项与三层开关。关闭时零影响。
2. **合并**:同步、三种策略、互斥锁、权限闸路径规则、checkpoint 提交。
3. **界面**:新会话开关、徽标、审核面板、侧栏圆点、设置页。
4. **收尾**:孤儿清理、启动 prune、`.prometheus/worktree.json`、多会话重叠提示、自动化接入。

放在 core 而不是 `plugins/git`,原因:创建发生在 `session.create` 之内,插件拿不到这个时机。`plugins/git` 保持只做 UI 侧的 git 读写,复用它的 `git()` 封装。

## 11. 测试

必须是对真实 git 仓库的集成测试(临时目录),不 mock git:

- 创建后主目录 `git status` 干净,工作树里改文件不影响主目录。
- 两个会话并发改不同文件、相同文件,依次合并的结果。
- 合并冲突时主目录始终无冲突标记,`git merge --abort` 后状态不变。
- 主目录有未提交改动:有交集被阻止,无交集允许。
- 丢弃后目录和分支都消失;重启后孤儿被清理。
- 工作树目录被手动删除后会话恢复。
- 开关全部关闭时,`session.create` 的结果与改动前逐字段相同。
- workspaceId 归属:工作树会话不会生成新项目。
- 权限闸:写 `worktree.root` 下的绝对路径被拒绝。

## 12. 我替你做的假设(可推翻)

1. 默认模式 `ask`,开关默认开。
2. 合并默认 squash,合并后默认清理工作树。
3. 已有会话不能中途切换。
4. 主目录未提交改动默认不带入。
5. 自动化默认不隔离。
6. v1 只支持 git 仓库,不做复制目录式的隔离。
7. 路径规则只防误写,不宣称是沙箱。

## 13. 风险

- workspaceId 归属改造牵涉面最大,漏改一处就会出现假项目或会话丢失。第一期先只做这一项并配测试。
- `node_modules` 用链接的方式存在两边互相影响的可能,文档和默认值要保守。
- checkpoint 提交会触发 hook 和签名提示,默认 `--no-verify` 与 `commit.gpgsign=false` 仅作用于 checkpoint 这类内部提交。
- 用户可能误以为"隔离"等于"安全沙箱"。界面文案用"独立工作树",不用"沙箱"。
