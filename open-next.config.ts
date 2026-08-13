import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Force-dynamic SSR — no ISR, no `use cache`, no next/image — so no
// incremental-cache / image bindings are needed and the default (uncached)
// config is correct. If ISR is ever added, wire an R2 or KV cache here
// (https://opennext.js.org/cloudflare/caching) and add the matching binding
// + WORKER_SELF_REFERENCE service in wrangler.jsonc.
export default defineCloudflareConfig();
