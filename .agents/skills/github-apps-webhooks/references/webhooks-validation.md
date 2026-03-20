# GitHub webhook validation

Source: [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

## Core rules

- GitHub signs payloads using **HMAC-SHA256** and sends the signature in `X-Hub-Signature-256`.
- The signature format is `sha256=<hex digest>`.
- Use the raw request body as the HMAC input and compare with a **constant-time** comparison (`crypto.timingSafeEqual`).
- If your webhook has no secret, GitHub will not send the signature header.
- Treat payloads as UTF-8 to avoid mismatched signatures.

## Test vector

The docs provide a known test vector:

- Secret: `It's a Secret to Everybody`
- Payload: `Hello, World!`
- Expected digest: `757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`
- Header value: `sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`
