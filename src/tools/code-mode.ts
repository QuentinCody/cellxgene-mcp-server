import type { McpServer } from "@bio-mcp/shared/mcp";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { cellxgeneCatalog } from "../spec/catalog";
import { createCellxgeneApiFetch } from "../lib/api-adapter";

interface CodeModeEnv {
    CELLXGENE_DATA_DO: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
}

export function registerCodeMode(
    server: McpServer,
    env: CodeModeEnv,
): void {
    const apiFetch = createCellxgeneApiFetch();

    const searchTool = createSearchTool({
        prefix: "cellxgene",
        catalog: cellxgeneCatalog,
    });
    searchTool.register(server as unknown as { tool: (...args: unknown[]) => void });

    const executeTool = createExecuteTool({
        prefix: "cellxgene",
        // Verifiable provenance: cellxgene_execute results carry a _meta.citation.
        source: { id: "cellxgene", name: "CZ CELLxGENE Discover", url: "https://cellxgene.cziscience.com" },
        catalog: cellxgeneCatalog,
        apiFetch,
        doNamespace: env.CELLXGENE_DATA_DO,
        loader: env.CODE_MODE_LOADER,
        // The isolate must outlive the HTTP budget it wraps, or the inner
        // timeout can never be reached. cellxgeneFetch allows 60s for the large
        // /collections and /datasets payloads (~3.1MB), but the executor
        // defaults to 30s — so those calls were killed by the OUTER clock and
        // surfaced as "Execution timed out" rather than as a slow-but-valid
        // response. Ordering must be: HTTP timeout < isolate timeout.
        timeout: 90_000,
    });
    executeTool.register(server as unknown as { tool: (...args: unknown[]) => void });
}
