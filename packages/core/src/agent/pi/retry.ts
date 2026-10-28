// Provider retries for PI chats. PI retries transient failures (including a stream that closes without a stop reason,
// which gateways and proxies cause when they time out or drop a long response) but only 3 times; a flaky link often
// needs more. The raised budget is held in memory only: a retry count the user set in settings.json is left alone.
const PI_DEFAULT_RETRIES = 3;
export const RETRIES = 6;

export function raiseRetryBudget(settings: { getRetrySettings(): { maxRetries: number }; applyOverrides(o: { retry: { maxRetries: number } }): void }): void {
	if (settings.getRetrySettings().maxRetries === PI_DEFAULT_RETRIES) settings.applyOverrides({ retry: { maxRetries: RETRIES } });
}
