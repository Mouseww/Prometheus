/**
 * Placeholder for the mainland China payment adapters (Alipay, WeChat Pay). Not implemented in this version.
 *
 * To add one, implement `PaymentProvider` (see provider.ts) in `providers/alipay.ts` or `providers/wechat.ts` and register it
 * next to the stripe and manual providers in `billing/index.ts`. The adapter needs the same three pieces as the stripe one:
 *  1. `createCheckout`: create the provider's order for `order.amountCents` and return the page the browser is sent to, plus the
 *     provider's order number as `providerRef` (it is stored in `orders.provider_ref`).
 *  2. `parseWebhook`: verify the provider's signature over the raw body (RSA2 for Alipay, APIv3 AES-GCM plus platform certificate
 *     signature for WeChat Pay) and map the notification to a `PaymentEvent`; return undefined when the signature is invalid.
 *  3. Nothing else: idempotency, crediting and subscription handling are done by the Hub from the returned events.
 *
 * Configuration keys reserved for the adapters (read from the environment, nothing consumes them yet):
 *   HUB_ALIPAY_APP_ID            Alipay application id
 *   HUB_ALIPAY_PRIVATE_KEY       application private key (PEM or path)
 *   HUB_ALIPAY_PUBLIC_KEY        Alipay public key used to verify notifications
 *   HUB_ALIPAY_GATEWAY           gateway URL (production or sandbox)
 *   HUB_WECHAT_APP_ID            WeChat Pay application id
 *   HUB_WECHAT_MCH_ID            merchant id
 *   HUB_WECHAT_API_V3_KEY        APIv3 key (decrypts notifications)
 *   HUB_WECHAT_CERT_SERIAL       merchant certificate serial number
 *   HUB_WECHAT_PRIVATE_KEY       merchant private key (PEM or path)
 */
export const CN_ADAPTER_ENV_KEYS = [
	"HUB_ALIPAY_APP_ID",
	"HUB_ALIPAY_PRIVATE_KEY",
	"HUB_ALIPAY_PUBLIC_KEY",
	"HUB_ALIPAY_GATEWAY",
	"HUB_WECHAT_APP_ID",
	"HUB_WECHAT_MCH_ID",
	"HUB_WECHAT_API_V3_KEY",
	"HUB_WECHAT_CERT_SERIAL",
	"HUB_WECHAT_PRIVATE_KEY",
] as const;
