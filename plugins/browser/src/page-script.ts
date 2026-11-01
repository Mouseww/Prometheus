// Runs in an isolated world of every page (pages cannot see it). It reports what a streamed picture cannot show:
// the mouse cursor, native <select> popups and the context menu (headless Chromium draws neither), and copied text
// (so the user's own clipboard gets it). Messages go out through a CDP binding that only this world has.

export const WORLD = "prometheus";
export const BINDING = "__prometheusBridge";

export const PAGE_SCRIPT = `(() => {
	if (window.__prometheusInstalled) return;
	window.__prometheusInstalled = true;
	const send = (msg) => { try { window.${BINDING}(JSON.stringify(msg)); } catch {} };
	const top = window === window.top;

	let cursor = "";
	let pending = null;
	let queued = false;
	const cursorOf = (el) => {
		if (!(el instanceof Element)) return "default";
		const c = getComputedStyle(el).cursor;
		if (c && c !== "auto") return c;
		if (el.closest("a[href],button,[role=button],label[for],summary,select")) return "pointer";
		if (el.closest("input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]):not([type=color]),textarea,[contenteditable=''],[contenteditable=true]")) return "text";
		const t = el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
		return t ? "text" : "default";
	};
	if (top) document.addEventListener("mousemove", (e) => {
		pending = e.target;
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			const c = cursorOf(pending);
			if (c !== cursor) { cursor = c; send({ t: "cursor", v: c }); }
		});
	}, { capture: true, passive: true });

	document.addEventListener("mousedown", (e) => {
		const s = e.target instanceof Element ? e.target.closest("select") : null;
		if (!s || s.multiple || s.size > 1 || s.disabled || e.button !== 0) return;
		e.preventDefault();
		s.focus();
		const r = s.getBoundingClientRect();
		const options = [];
		for (const el of s.querySelectorAll("option")) {
			const g = el.parentElement && el.parentElement.tagName === "OPTGROUP" ? el.parentElement.label : undefined;
			options.push({ label: el.label || el.textContent.trim(), value: el.value, disabled: el.disabled || (el.parentElement && el.parentElement.disabled) || false, selected: el.selected, group: g });
		}
		send({ t: "select", x: e.clientX, y: e.clientY, rect: [r.left, r.top, r.width, r.height], options, frame: !top });
	}, true);

	if (top) document.addEventListener("contextmenu", (e) => {
		const el = e.target instanceof Element ? e.target : null;
		const a = el && el.closest("a[href]");
		const img = el && el.closest("img");
		const ed = el && el.closest("input,textarea,[contenteditable=''],[contenteditable=true]");
		let sel = String(getSelection() || "");
		const ae = document.activeElement;
		if (!sel && ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") && typeof ae.selectionStart === "number") sel = ae.value.slice(ae.selectionStart, ae.selectionEnd);
		send({ t: "menu", x: e.clientX, y: e.clientY, link: a ? a.href : undefined, image: img ? img.currentSrc || img.src : undefined, selection: sel.slice(0, 100000), editable: !!ed });
	}, true);

	const copied = () => {
		let text = String(getSelection() || "");
		const ae = document.activeElement;
		if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") && typeof ae.selectionStart === "number" && ae.type !== "password") text = ae.value.slice(ae.selectionStart, ae.selectionEnd);
		if (text) send({ t: "copy", text: text.slice(0, 1000000) });
	};
	document.addEventListener("copy", copied, true);
	document.addEventListener("cut", copied, true);
})();`;
