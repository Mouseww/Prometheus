import type { ProviderResponse, ProviderStreamEvent } from "./types.js";

export async function collectProviderStream(
  stream: AsyncIterable<ProviderStreamEvent>,
  onTextDelta?: (delta: string) => Promise<void> | void,
): Promise<ProviderResponse> {
  let completed: ProviderResponse | undefined;

  for await (const event of stream) {
    if (event.type === "text.delta") {
      if (event.delta) await onTextDelta?.(event.delta);
      continue;
    }
    if (completed) throw new ProviderStreamProtocolError("Provider stream completed more than once");
    completed = event.response;
  }

  if (!completed) throw new ProviderStreamProtocolError("Provider stream ended before completion");
  return completed;
}

export class ProviderStreamProtocolError extends Error {}
