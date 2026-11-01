import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const PAGES: Record<string, string> = {
	"/": `<!doctype html><html><head><title>Home</title></head><body>
		<h1>Test home</h1>
		<a href="/form">Go to form</a>
		<a href="/popup" target="_blank">Open popup</a>
		<button id="alert" onclick="alert('hello there')">Alert me</button>
		<button id="confirm" onclick="document.getElementById('out').textContent = confirm('sure?') ? 'yes' : 'no'">Confirm me</button>
		<p id="out"></p>
	</body></html>`,
	"/form": `<!doctype html><html><head><title>Form</title></head><body>
		<h1>Sign up</h1>
		<label>Name <input id="name"></label>
		<label>Password <input id="pw" type="password" value="hunter2"></label>
		<label>Color <select id="color"><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select></label>
		<label><input type="checkbox" id="agree"> I agree</label>
		<input type="file" id="file">
		<button id="go" onclick="document.getElementById('result').textContent = 'Hello ' + document.getElementById('name').value + ' ' + document.getElementById('color').value + ' ' + document.getElementById('agree').checked + ' ' + (document.getElementById('file').files[0]?.name ?? '-')">Submit</button>
		<p id="result"></p>
		<div id="cover" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5)">Cookie banner</div>
		<button id="later" onclick="setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Loaded later'; document.body.append(p); }, 400)">Load later</button>
	</body></html>`,
	"/touch": `<!doctype html><html><head><title>Touch</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">
		<button id="tap" style="display:block;width:200px;height:80px" onclick="document.title = 'tapped'">Tap me</button>
		<div id="info"></div>
		<div style="height:3000px"></div>
		<script>
			document.getElementById("info").textContent = [innerWidth, navigator.maxTouchPoints, /Mobile/.test(navigator.userAgent), matchMedia("(pointer: coarse)").matches].join(",");
		</script>
	</body></html>`,
	"/popup": `<!doctype html><html><head><title>Popup</title></head><body><h1>Popup page</h1></body></html>`,
	"/frame": `<!doctype html><html><head><title>Frames</title></head><body><h1>Outer</h1><iframe src="/form" width="600" height="400"></iframe></body></html>`,
};

export async function startSite(): Promise<{ url: string; server: Server }> {
	const server = createServer((req, res) => {
		const page = PAGES[(req.url ?? "/").split("?")[0] ?? "/"];
		if (!page) {
			res.writeHead(404);
			return res.end("not found");
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(page);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
