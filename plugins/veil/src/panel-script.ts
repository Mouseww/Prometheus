/**
 * Panel behaviour. Runs inside a sandboxed iframe with no access to the host's storage, so it
 * talks to the plugin over its own JSON routes under `/plugins/veil/`.
 */
export const PANEL_SCRIPT = String.raw`
(function () {
  "use strict";

  var base = "/plugins/veil";
  var current = null;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function api(path, body) {
    var opts = body === undefined
      ? { credentials: "same-origin" }
      : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    return fetch(base + path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
        return data;
      });
    });
  }

  function showError(node, msg) {
    if (!node) return;
    node.textContent = msg || "";
    node.classList.toggle("hidden", !msg);
  }

  // ---------- tabs ----------

  var tabs = ["privacy", "proxy", "rules"];
  document.querySelectorAll(".bar button").forEach(function (b) {
    b.addEventListener("click", function () {
      tabs.forEach(function (t) {
        $("tab-" + t).classList.toggle("hidden", t !== b.dataset.tab);
        document.querySelector('.bar button[data-tab="' + t + '"]').classList.toggle("on", t === b.dataset.tab);
      });
      if (b.dataset.tab === "proxy") loadHits();
      if (b.dataset.tab === "rules") renderRules();
      if (b.dataset.tab === "privacy") loadMappings();
    });
  });

  // ---------- state ----------

  function apply(state) {
    current = state;
    var c = state.config;
    $("t-redaction").checked = c.redaction;
    $("t-region").checked = c.regionNeutral;
    $("acceptLanguage").value = c.acceptLanguage;
    $("t-relay").checked = c.relay;
    $("relayPort").value = c.relayPort;
    $("upstream").value = c.upstream;
    $("proxyUrl").value = c.proxyServer ? (c.proxyKind === "socks5" ? "socks5://" : "http://") + c.proxyServer : "";
    $("proxy-auth-hint").textContent = c.proxyAuth ? "已保存用户名密码（留空重填可更换）" : "没有保存凭据。地址里带上 user:pass@ 即可。";
    $("pack-secrets").checked = c.packs.secrets;
    $("pack-region").checked = c.packs.region;
    $("allowlist").value = c.allowlist.join("\n");

    var rs = state.relay;
    var box = $("relay-status");
    box.innerHTML = "";
    if (rs.running) {
      var ok = el("span", "pill ok", "转发中");
      box.appendChild(ok);
      var u = el("span", "mono", "  " + rs.baseUrl);
      box.appendChild(u);
    } else {
      box.appendChild(el("span", "pill", "未运行"));
      if (rs.error) box.appendChild(el("div", "err", rs.error));
    }
    $("mapping-summary").textContent = "共 " + state.stats.mappings + " 条映射";
    renderRules();
  }

  function reload() {
    return api("/state").then(apply).catch(function (e) { alert("读取状态失败：" + e.message); });
  }

  // ---------- privacy ----------

  $("t-redaction").addEventListener("change", function (e) {
    api("/rpc/setFlags", { redaction: e.target.checked }).then(apply).catch(function (err) { alert(err.message); });
  });
  $("t-region").addEventListener("change", function (e) {
    api("/rpc/setFlags", { regionNeutral: e.target.checked }).then(apply).catch(function (err) { alert(err.message); });
  });
  $("save-headers").addEventListener("click", function () {
    api("/rpc/setHeaders", { acceptLanguage: $("acceptLanguage").value }).then(apply).then(function () {
      $("save-headers").textContent = "已保存";
      setTimeout(function () { $("save-headers").textContent = "保存"; }, 1400);
    }).catch(function (err) { alert(err.message); });
  });

  $("run-test").addEventListener("click", function () {
    var text = $("test-input").value;
    if (!text.trim()) return;
    api("/rpc/testRules", { text: text }).then(function (r) {
      var out = $("test-result");
      out.innerHTML = "";
      if (!r.hits.length) { out.appendChild(el("div", "empty", "没有命中任何规则。")); return; }
      var list = el("div", "card");
      list.style.margin = "0 0 10px";
      r.hits.forEach(function (h) {
        var row = el("div", "row");
        var t = el("div", "row-text");
        var title = el("div", "row-title");
        title.appendChild(el("span", "type", h.type));
        title.appendChild(document.createTextNode("  " + h.value));
        t.appendChild(title);
        row.appendChild(t);
        list.appendChild(row);
      });
      out.appendChild(list);
      out.appendChild(el("div", "mono", r.preview));
    }).catch(function (err) { alert(err.message); });
  });

  function loadMappings() {
    api("/rpc/mappings", { limit: 50 }).then(function (r) {
      $("mapping-summary").textContent = "共 " + r.total + " 条映射";
      var list = $("mapping-list");
      list.innerHTML = "";
      if (!r.entries.length) { list.appendChild(el("div", "empty", "还没有映射。发一次含敏感信息的请求就会产生。")); return; }
      var table = el("table");
      var head = el("tr");
      ["类型", "化名", "原值", "时间"].forEach(function (h) { head.appendChild(el("th", "", h)); });
      table.appendChild(head);
      r.entries.forEach(function (e) {
        var tr = el("tr");
        tr.appendChild(el("td", "", e.type)).firstChild.className = "type";
        var token = el("td");
        token.appendChild(el("span", "mono", e.token));
        tr.appendChild(token);
        tr.appendChild(el("td", "mono", e.masked));
        tr.appendChild(el("td", "mono", new Date(e.createdAt).toLocaleString()));
        table.appendChild(tr);
      });
      list.appendChild(table);
    }).catch(function (err) { alert(err.message); });
  }
  $("refresh-mappings").addEventListener("click", loadMappings);
  $("clear-mappings").addEventListener("click", function () {
    if (!confirm("清空所有化名映射？旧的对话里出现过的化名将无法再换回原文。")) return;
    api("/rpc/clearMappings", {}).then(loadMappings).catch(function (err) { alert(err.message); });
  });

  // ---------- proxy ----------

  $("t-relay").addEventListener("change", function (e) {
    var box = $("relay-msg");
    api("/rpc/setFlags", { relay: e.target.checked }).then(apply).then(function () {
      showError(box, "");
      box.textContent = e.target.checked ? "已开启。网关地址已指向本机转发端口。" : "已关闭，恢复直连。";
      box.classList.remove("hidden");
      setTimeout(function () { box.classList.add("hidden"); }, 3000);
      if (e.target.checked) loadHits();
    }).catch(function (err) { e.target.checked = !e.target.checked; alert(err.message); });
  });

  $("save-proxy").addEventListener("click", function () {
    var err = $("proxy-error");
    showError(err, "");
    api("/rpc/setProxy", { url: $("proxyUrl").value }).then(apply).catch(function (e) { showError(err, e.message); });
  });
  $("clear-proxy").addEventListener("click", function () {
    api("/rpc/setProxy", { url: "" }).then(apply).then(function () { $("proxyUrl").value = ""; }).catch(function (e) { showError($("proxy-error"), e.message); });
  });
  $("save-relay").addEventListener("click", function () {
    api("/rpc/setRelay", { port: Number($("relayPort").value), upstream: $("upstream").value }).then(apply).then(function () {
      var m = $("relay-msg");
      m.textContent = "已保存。";
      m.classList.remove("hidden");
      setTimeout(function () { m.classList.add("hidden"); }, 2000);
    }).catch(function (e) { showError($("proxy-error"), e.message); });
  });
  $("restart-relay").addEventListener("click", function () {
    api("/rpc/restartRelay", {}).then(apply).catch(function (e) { showError($("proxy-error"), e.message); });
  });

  function loadHits() {
    api("/rpc/hits", {}).then(function (r) {
      var list = $("hit-list");
      list.innerHTML = "";
      if (!r.entries.length) { list.appendChild(el("div", "empty", "还没有转发记录。")); return; }
      var table = el("table");
      var head = el("tr");
      ["时间", "方法", "上游", "状态", "命中", "耗时"].forEach(function (h) { head.appendChild(el("th", "", h)); });
      table.appendChild(head);
      r.entries.forEach(function (e) {
        var tr = el("tr");
        tr.appendChild(el("td", "mono", new Date(e.at).toLocaleTimeString()));
        tr.appendChild(el("td", "mono", e.method));
        tr.appendChild(el("td", "mono", e.upstream + e.path));
        tr.appendChild(el("td", "mono", String(e.status)));
        tr.appendChild(el("td", "mono", e.types.join(", ") || "—"));
        tr.appendChild(el("td", "mono", e.durationMs + "ms"));
        table.appendChild(tr);
      });
      list.appendChild(table);
    }).catch(function (err) { alert(err.message); });
  }
  $("refresh-hits").addEventListener("click", loadHits);
  $("clear-hits").addEventListener("click", function () { api("/rpc/clearHits", {}).then(function () { loadHits(); }); });

  // ---------- rules ----------

  var BUILTIN = { pem:1, apikey:1, token:1, connstr:1, password:1, idcard:1, phone:1, ip:1, email:1, timezone:1, locale:1 };

  function renderRules() {
    if (!current) return;
    var list = $("rule-list");
    list.innerHTML = "";
    current.config.rules.slice().sort(function (a, b) { return b.priority - a.priority; }).forEach(function (rule) {
      var row = el("details", "rule");
      var sum = el("summary");
      var toggle = el("label", "toggle");
      var cb = el("input");
      cb.type = "checkbox";
      cb.checked = rule.enabled;
      cb.addEventListener("click", function (e) { e.stopPropagation(); });
      cb.addEventListener("change", function (e) {
        e.stopPropagation();
        api("/rpc/toggleRule", { id: rule.id, enabled: cb.checked }).then(apply).catch(function (err) { alert(err.message); cb.checked = !cb.checked; });
      });
      toggle.appendChild(cb);
      toggle.appendChild(el("span"));
      sum.appendChild(toggle);
      sum.appendChild(el("span", "type", rule.typePrefix));
      sum.appendChild(el("span", "", rule.id));
      if (BUILTIN[rule.id]) sum.appendChild(el("span", "builtin", "内置"));
      sum.appendChild(el("span", "mono", " p" + rule.priority));
      row.appendChild(sum);

      var body = el("div");
      body.style.paddingLeft = "46px";
      if (rule.kind === "regex") {
        body.appendChild(el("div", "mono", rule.pattern || ""));
      } else if (rule.kind === "dictionary") {
        body.appendChild(el("div", "mono", (rule.words || []).join("、")));
      } else {
        body.appendChild(el("div", "mono", "按地址解析，没有正则"));
      }
      if (!BUILTIN[rule.id]) {
        var act = el("div", "actions");
        var del = el("button", "danger", "删除");
        del.addEventListener("click", function () {
          api("/rpc/deleteRule", { id: rule.id }).then(apply).catch(function (err) { alert(err.message); });
        });
        act.appendChild(del);
        body.appendChild(act);
      }
      row.appendChild(body);
      list.appendChild(row);
    });
  }

  $("pack-secrets").addEventListener("change", function (e) {
    api("/rpc/setPacks", { secrets: e.target.checked, region: $("pack-region").checked }).then(apply).catch(function (err) { alert(err.message); });
  });
  $("pack-region").addEventListener("change", function (e) {
    api("/rpc/setPacks", { secrets: $("pack-secrets").checked, region: e.target.checked }).then(apply).catch(function (err) { alert(err.message); });
  });

  $("add-rule").addEventListener("click", function () {
    var err = $("rule-error");
    showError(err, "");
    var kind = $("new-kind").value;
    var raw = $("new-pattern").value;
    var rule = {
      id: $("new-id").value.trim(),
      name: $("new-id").value.trim(),
      typePrefix: $("new-type").value.trim(),
      enabled: true,
      kind: kind,
      priority: Number($("new-priority").value) || 100
    };
    if (kind === "dictionary") rule.words = raw.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
    else rule.pattern = raw.trim();
    api("/rpc/setRule", { rule: rule }).then(function (s) {
      apply(s);
      $("new-id").value = ""; $("new-type").value = ""; $("new-pattern").value = "";
    }).catch(function (e) { showError(err, e.message); });
  });

  $("save-allowlist").addEventListener("click", function () {
    api("/rpc/setAllowlist", { allowlist: $("allowlist").value.split("\n") }).then(apply).catch(function (err) { alert(err.message); });
  });

  reload();
})();
`;
