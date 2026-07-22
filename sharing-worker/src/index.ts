/**
 * Cloudflare Worker for serving and uploading shared session snapshots.
 *
 * R2 binding provides direct bucket access — no API tokens or sigv4 needed.
 * Uploads are authenticated with a shared secret (set via `wrangler secret put UPLOAD_SECRET`).
 *
 * Setup:
 *   cd sharing-worker
 *   npm install
 *   npx wrangler deploy
 *   npx wrangler secret put UPLOAD_SECRET   # pick any secret
 *
 * Then create ~/.yep-anywhere/sharing.json:
 *   { "workerUrl": "https://yep-sharing.<account>.workers.dev", "secret": "<same secret>" }
 */

interface Env {
  SHARES: R2Bucket;
  UPLOAD_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = url.pathname.slice(1); // strip leading /

    if (!key) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "GET") {
      const object = await env.SHARES.get(key);
      if (!object) {
        return new Response("Not found", { status: 404 });
      }

      const headers = new Headers();
      headers.set("content-type", "text/html; charset=utf-8");
      headers.set("cache-control", "public, max-age=31536000, immutable");

      // If stored gzipped (legacy), decompress before serving.
      // Cloudflare edge handles compression automatically for browsers.
      let body: ReadableStream | null = object.body;
      if (object.httpMetadata?.contentEncoding === "gzip") {
        body = object.body.pipeThrough(new DecompressionStream("gzip"));
      }

      return new Response(body, { headers });
    }

    if (request.method === "PUT") {
      const auth = request.headers.get("authorization");
      if (auth !== `Bearer ${env.UPLOAD_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const body = await request.arrayBuffer();

      await env.SHARES.put(key, body, {
        httpMetadata: {
          contentType: "text/html; charset=utf-8",
          cacheControl: "public, max-age=31536000, immutable",
        },
      });

      return new Response(JSON.stringify({ url: `${url.origin}/${key}` }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Method not allowed", { status: 405 });
  },
} satisfies ExportedHandler<Env>;
