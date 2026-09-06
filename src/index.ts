import { error } from "./http";
import { handleUploadHost } from "./upload-host";
import { handleViewHost } from "./view-host";

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const host = new URL(request.url).host;
      if (host === env.VIEW_HOST) return await handleViewHost(request, env);
      return await handleUploadHost(request, env);
    } catch (err) {
      console.error("unhandled", err instanceof Error ? (err.stack ?? err.message) : String(err));
      return error(500, "Something went wrong");
    }
  },
} satisfies ExportedHandler<Env>;
