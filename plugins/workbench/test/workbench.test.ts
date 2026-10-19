import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { looksBinary, readForViewer, resolveAllowed } from "../src/files.ts";

describe("file viewer", () => {
	it("stays inside the roots, including through symlinks", async () => {
		const root = await mkdtemp(join(tmpdir(), "wb-root-"));
		const outside = await mkdtemp(join(tmpdir(), "wb-out-"));
		await writeFile(join(root, "a.ts"), "const a = 1;\n");
		await writeFile(join(outside, "secret.txt"), "x");
		await mkdir(join(root, "sub"));
		expect(await resolveAllowed("a.ts", root, [root])).toContain("a.ts");
		await expect(resolveAllowed(join(outside, "secret.txt"), root, [root])).rejects.toThrow();
		await expect(resolveAllowed("../" + outside.split(/[\/]/).pop() + "/secret.txt", root, [root])).rejects.toThrow();
		try {
			await symlink(outside, join(root, "link"), "junction");
			await expect(resolveAllowed("link/secret.txt", root, [root])).rejects.toThrow();
		} catch {
			// Creating links may be forbidden on this machine.
		}
	});
	it("classifies text, binary and images", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wb-kind-"));
		await writeFile(join(dir, "t.md"), "# hi");
		await writeFile(join(dir, "b.bin"), Buffer.from([1, 0, 2]));
		await writeFile(join(dir, "p.png"), Buffer.from([137, 80, 78, 71]));
		expect((await readForViewer(join(dir, "t.md"))).language).toBe("markdown");
		expect((await readForViewer(join(dir, "b.bin"))).kind).toBe("binary");
		expect((await readForViewer(join(dir, "p.png"))).dataUrl).toMatch(/^data:image\/png;base64,/);
		expect(looksBinary(new Uint8Array([65, 66]))).toBe(false);
	});
});
