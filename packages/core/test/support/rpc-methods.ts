import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Every key of the protocol's `RpcMethods` interface, read from its source so a new method shows up here without anyone remembering to list it. */
export function rpcMethodNames(): string[] {
	const source = readFileSync(fileURLToPath(new URL("../../../protocol/src/index.ts", import.meta.url)), "utf8");
	const start = source.indexOf("export interface RpcMethods");
	const end = source.indexOf("\n}\n", start);
	const names = [...source.slice(start, end).matchAll(/^\t"([A-Za-z.]+)":/gm)].map((m) => m[1] as string);
	if (names.length < 50) throw new Error(`parsed only ${names.length} RPC methods; the interface layout changed`);
	return names;
}
