import { expect, it } from "vitest";
import { languageFromPath } from "./language";

it("maps common extensions to monaco languages", () => {
  expect(languageFromPath("apps/client/src/App.tsx")).toBe("typescript");
  expect(languageFromPath("apps/server-rs/src/main.rs")).toBe("rust");
  expect(languageFromPath("README.md")).toBe("markdown");
  expect(languageFromPath("package.json")).toBe("json");
  expect(languageFromPath("script.py")).toBe("python");
  expect(languageFromPath("unknown.bin")).toBe("plaintext");
});
