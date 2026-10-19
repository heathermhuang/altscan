// Registers the homepage's WebMCP tools (src/lib/webmcp.ts) with an in-browser agent. Most browsers
// have no model context yet, and then this does nothing.
import { webMcpTools } from '../lib/webmcp';

type ModelContext = {
  registerTool?(tool: unknown): unknown;
  provideContext?(ctx: { tools: unknown[] }): unknown;
};

// The spec moved the API from navigator to document; older Chrome builds still have only the former.
const mc =
  (document as unknown as { modelContext?: ModelContext }).modelContext ??
  (navigator as unknown as { modelContext?: ModelContext }).modelContext;

if (mc) {
  const tools = webMcpTools((url) => window.location.assign(url));
  try {
    if (typeof mc.registerTool === 'function') {
      for (const tool of tools) void Promise.resolve(mc.registerTool(tool)).catch(() => {});
    } else {
      void Promise.resolve(mc.provideContext?.({ tools })).catch(() => {});
    }
  } catch {
    // Refused (e.g. by a permissions policy); the page works without it.
  }
}
