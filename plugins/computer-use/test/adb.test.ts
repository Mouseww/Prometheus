import { describe, expect, it } from "vitest";
import { parseDump, toTree } from "../src/driver/adb.ts";
import { prune } from "../src/engine/prune.ts";
import { render } from "../src/engine/render.ts";

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
  <node index="0" text="WLAN" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,200][400,260]" />
  <node index="1" text="" resource-id="com.android.settings:id/switch_widget" class="android.widget.Switch" package="com.android.settings" content-desc="WLAN 开关" checkable="true" checked="true" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[900,190][1040,270]" />
  <node index="2" text="a &amp; b" resource-id="com.android.settings:id/search" class="android.widget.EditText" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,300][1040,400]" />
  <node index="3" text="secret" resource-id="" class="android.widget.EditText" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="true" selected="false" bounds="[40,420][1040,500]" />
  <node index="4" text="" resource-id="" class="androidx.recyclerview.widget.RecyclerView" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="true" long-clickable="false" password="false" selected="false" bounds="[0,520][1080,2300]">
    <node index="0" text="蓝牙" resource-id="" class="android.widget.Button" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[0,540][1080,700]" />
  </node>
</node>
</hierarchy>
UI hierchary dumped to: /dev/tty`;

describe("uiautomator dump", () => {
	it("parses nodes, entities and nesting", () => {
		const raw = parseDump(DUMP)!;
		expect(raw.attrs.package).toBe("com.android.settings");
		expect(raw.children).toHaveLength(5);
		expect(raw.children[2]!.attrs.text).toBe("a & b");
		expect(raw.children[4]!.children[0]!.attrs.text).toBe("蓝牙");
		expect(parseDump("no xml here")).toBeUndefined();
	});

	it("maps classes to roles, states and actions, hides passwords and keeps refs stable", () => {
		const keys = new Map<string, string>();
		let n = 1;
		const refFor = (k: string) => keys.get(k) ?? (keys.set(k, `e${n++}`), keys.get(k)!);
		const t1 = toTree(parseDump(DUMP)!, refFor);
		const t2 = toTree(parseDump(DUMP)!, refFor);
		expect(t2.root.children!.map((c) => c.ref)).toEqual(t1.root.children!.map((c) => c.ref));

		const [title, sw, search, pw, list] = t1.root.children!;
		expect(title).toMatchObject({ role: "text", name: "WLAN" });
		expect(sw).toMatchObject({ role: "checkbox", name: "WLAN 开关", states: ["checked"], actions: ["toggle", "click"] });
		expect(search).toMatchObject({ role: "textbox", value: "a & b", states: ["focused", "editable"] });
		expect(pw!.states).toContain("password");
		expect(pw!.value).toBeUndefined();
		expect(list).toMatchObject({ role: "list", actions: ["scroll"] });
		expect(list!.children![0]).toMatchObject({ role: "button", name: "蓝牙", actions: ["click", "right_click"] });
		expect(t1.centres.get(sw!.ref)).toEqual([970, 230]);
	});

	it("renders compactly through the shared engine", () => {
		const tree = toTree(parseDump(DUMP)!, (k) => `r${k.length}`);
		const text = render(prune(tree.root).tree, { budget: 1000 }).text;
		expect(text).toContain('checkbox "WLAN 开关" checked');
		expect(text).toContain('textbox "a & b"');
		expect(text).not.toContain("secret");
	});
});
