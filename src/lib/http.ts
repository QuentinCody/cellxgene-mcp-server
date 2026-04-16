import { restFetch } from "@bio-mcp/shared/http/rest-fetch";
import type { RestFetchOptions } from "@bio-mcp/shared/http/rest-fetch";

const CELLXGENE_BASE = "https://api.cellxgene.cziscience.com/curation/v1";

export interface CellxgeneFetchOptions extends Omit<RestFetchOptions, "retryOn"> {
    baseUrl?: string;
}

/**
 * Fetch from the CELLxGENE Discover curation API.
 */
export async function cellxgeneFetch(
    path: string,
    params?: Record<string, unknown>,
    opts?: CellxgeneFetchOptions,
): Promise<Response> {
    const baseUrl = opts?.baseUrl ?? CELLXGENE_BASE;
    const headers: Record<string, string> = {
        Accept: "application/json",
        ...(opts?.headers ?? {}),
    };

    return restFetch(baseUrl, path, params, {
        ...opts,
        headers,
        retryOn: [429, 500, 502, 503],
        retries: opts?.retries ?? 3,
        // Collection list can be large/slow — allow extra time.
        timeout: opts?.timeout ?? 60_000,
        userAgent: "cellxgene-mcp-server/1.0 (bio-mcp)",
    });
}
