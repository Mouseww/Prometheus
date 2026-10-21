/** The panel page shell. All behaviour lives in `panel-script.ts`, inlined so the page is one request. */
import { PANEL_SCRIPT } from "./panel-script.ts";
import { page } from "./proxy/panel-html.ts";

export function renderPanel(): string {
	return page(
		"隐私面罩",
		`
<div class="bar">
  <button data-tab="privacy" class="on">隐私保护</button>
  <button data-tab="proxy">出口代理</button>
  <button data-tab="rules">规则</button>
</div>

<section id="tab-privacy">
  <h1>隐私保护</h1>
  <p class="sub">发往模型的请求先在本机把密钥、手机号、连接串等换成化名，回答回到屏幕时再换回原文。上游只看见化名。</p>

  <div class="card">
    <div class="row">
      <div class="row-text">
        <div class="row-title">启用脱敏</div>
        <div class="row-hint">关掉后请求原样发往上游，已保存的化名映射不会删除。</div>
      </div>
      <label class="toggle"><input type="checkbox" id="t-redaction"><span></span></label>
    </div>
    <div class="row">
      <div class="row-text">
        <div class="row-title">区域中立化</div>
        <div class="row-hint">把 <code>Accept-Language</code> 换成下面的值，禁用压缩以免化名被压掉。</div>
      </div>
      <label class="toggle"><input type="checkbox" id="t-region"><span></span></label>
    </div>
    <label class="field" style="margin-top:12px">
      <span>Accept-Language</span>
      <input type="text" id="acceptLanguage" placeholder="en-US,en;q=0.9">
    </label>
    <div class="actions"><button class="primary" id="save-headers">保存</button></div>
  </div>

  <div class="card">
    <h2>试一下</h2>
    <p class="sub" style="margin-bottom:10px">粘贴一段文本，看看会被换成什么。不会发送到任何地方。</p>
    <textarea id="test-input" placeholder="查一下 mysql://root:Pass123@10.1.2.3:3306/app，电话打 13800138000"></textarea>
    <div class="actions"><button id="run-test">脱敏</button></div>
    <div id="test-result" style="margin-top:12px"></div>
  </div>

  <div class="card">
    <h2>化名映射</h2>
    <div id="mapping-summary" class="row-hint" style="margin-bottom:10px"></div>
    <div id="mapping-list"></div>
    <div class="actions">
      <button id="refresh-mappings">刷新</button>
      <button class="danger" id="clear-mappings">清空映射</button>
    </div>
  </div>
</section>

<section id="tab-proxy" class="hidden">
  <h1>出口代理</h1>
  <p class="sub">让软件发出的模型请求从一个你指定的出口 IP 出去。插件会在本机开一个转发端口，再由这里配置的代理出网。</p>

  <div class="card">
    <div class="row">
      <div class="row-text">
        <div class="row-title">启用出口代理</div>
        <div class="row-hint">开启后，网关的地址会被指到本机转发端口；关掉后恢复直连。</div>
      </div>
      <label class="toggle"><input type="checkbox" id="t-relay"><span></span></label>
    </div>
    <div id="relay-status" style="margin:12px 0 0"></div>
  </div>

  <div class="card">
    <h2>代理服务器</h2>
    <label class="field">
      <span>地址（支持 http:// 与 socks5://，可带用户名密码）</span>
      <input type="text" id="proxyUrl" placeholder="socks5://user:pass@127.0.0.1:1080">
    </label>
    <div class="row-hint" id="proxy-auth-hint"></div>
    <div class="actions">
      <button class="primary" id="save-proxy">保存代理</button>
      <button id="clear-proxy">不用代理</button>
    </div>
    <div class="err hidden" id="proxy-error"></div>
  </div>

  <div class="card">
    <h2>转发端口</h2>
    <div class="grid2">
      <label class="field"><span>监听端口（1024–65535）</span><input type="number" id="relayPort" min="1024" max="65535"></label>
      <label class="field"><span>上游地址（裸路径请求时使用，可留空）</span><input type="text" id="upstream" placeholder="https://api.anthropic.com"></label>
    </div>
    <div class="actions">
      <button class="primary" id="save-relay">保存</button>
      <button id="restart-relay">重启转发</button>
    </div>
    <div class="okmsg hidden" id="relay-msg"></div>
  </div>

  <div class="card">
    <h2>最近的转发</h2>
    <div id="hit-list"></div>
    <div class="actions">
      <button id="refresh-hits">刷新</button>
      <button id="clear-hits">清空</button>
    </div>
  </div>
</section>

<section id="tab-rules" class="hidden">
  <h1>规则</h1>
  <p class="sub">命中的字在出网前换成 <code>{{类型_ULID}}</code>。优先级高的先匹配，先匹配到的占住位置。</p>

  <div class="card">
    <h2>规则包</h2>
    <div class="row">
      <div class="row-text"><div class="row-title">密钥包</div><div class="row-hint">私钥、API Key、Token、连接串、密码、身份证、手机号、IP、邮箱</div></div>
      <label class="toggle"><input type="checkbox" id="pack-secrets"><span></span></label>
    </div>
    <div class="row">
      <div class="row-text"><div class="row-title">区域包</div><div class="row-hint">时区（Asia/Shanghai 等）、locale（zh-CN）</div></div>
      <label class="toggle"><input type="checkbox" id="pack-region"><span></span></label>
    </div>
  </div>

  <div class="card">
    <h2>规则列表</h2>
    <div id="rule-list"></div>
  </div>

  <div class="card">
    <h2>新增规则</h2>
    <div class="grid2">
      <label class="field"><span>id（唯一）</span><input type="text" id="new-id" placeholder="project-codename"></label>
      <label class="field"><span>类型（会出现在化名里）</span><input type="text" id="new-type" placeholder="CODENAME"></label>
    </div>
    <label class="field"><span>匹配方式</span>
      <select id="new-kind">
        <option value="regex">正则</option>
        <option value="dictionary">词表（一行一个）</option>
      </select>
    </label>
    <label class="field"><span>优先级（大的先匹配）</span><input type="number" id="new-priority" value="100"></label>
    <label class="field"><span>正则表达式 / 词表</span><textarea id="new-pattern" placeholder="正则：ACME-[0-9]{4}&#10;词表：一行一个词"></textarea></label>
    <div class="actions"><button class="primary" id="add-rule">添加规则</button></div>
    <div class="err hidden" id="rule-error"></div>
  </div>

  <div class="card">
    <h2>白名单</h2>
    <p class="sub" style="margin-bottom:10px">这些字符串永远不替换。一行一个。</p>
    <textarea id="allowlist" placeholder="127.0.0.1&#10;localhost"></textarea>
    <div class="actions"><button class="primary" id="save-allowlist">保存白名单</button></div>
  </div>
</section>
`,
		PANEL_SCRIPT,
	);
}
