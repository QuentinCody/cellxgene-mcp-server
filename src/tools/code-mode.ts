import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
    });
    executeTool.register(server as unknown as { tool: (...args: unknown[]) => void });
}
