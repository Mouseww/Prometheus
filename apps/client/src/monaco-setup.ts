import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

let configured = false;

export function ensureMonacoConfigured(): void {
  if (configured) return;
  configured = true;
  // Bundle monaco with the app instead of the default CDN loader.
  loader.config({ monaco });
}
