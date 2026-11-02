// Module resolution hooks (loaded through module.register by main.js): `@earendil-works/*` is not next to the server
// bundle but in the folder the PI agent was installed into, so when the normal lookup fails it is retried from there.
// The packages' own dependencies then resolve from where they sit, as usual.
let parent;

export function initialize(data) {
	parent = data?.parent;
}

export async function resolve(specifier, context, nextResolve) {
	try {
		return await nextResolve(specifier, context);
	} catch (err) {
		if (parent && specifier.startsWith("@earendil-works/") && (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED")) {
			try {
				return await nextResolve(specifier, { ...context, parentURL: parent });
			} catch {
				// Report the original failure: it names what the importer asked for.
			}
		}
		throw err;
	}
}
