import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { cellxgeneFetch } from "./http";
import { censusError, censusFetch, type CensusEnv } from "./census";

export function createCellxgeneApiFetch(env: CensusEnv = {}): ApiFetchFn {
    return async (request) => {
        const path = request.path.startsWith("/") ? request.path : `/${request.path}`;
        if (path === "/census" || path.startsWith("/census/")) return { status: 200, data: await censusFetch({ ...request, path }, env) };
        if (request.method.toUpperCase() !== "GET" || request.body !== undefined) censusError("Discover metadata routes accept GET without a body only");
        const response = await cellxgeneFetch(request.path, request.params);

        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = response.statusText;
            }
            const error = new Error(`HTTP ${response.status}: ${errorBody.slice(0, 200)}`) as Error & {
                status: number;
                data: unknown;
            };
            error.status = response.status;
            error.data = errorBody;
            throw error;
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("json")) {
            const text = await response.text();
            return { status: response.status, data: text };
        }

        const data = await response.json();
        return { status: response.status, data };
    };
}
