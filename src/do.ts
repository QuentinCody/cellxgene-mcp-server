import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

export class CellxgeneDataDO extends RestStagingDO {
    protected getSchemaHints(data: unknown): SchemaHints | undefined {
        if (!data || typeof data !== "object") return undefined;

        // Array response (e.g. /collections, /datasets)
        if (Array.isArray(data)) {
            const sample = data[0];
            if (sample && typeof sample === "object") {
                if ("collection_id" in sample || ("collection_url" in sample && "datasets" in sample)) {
                    return {
                        tableName: "collections",
                        indexes: ["collection_id", "name", "visibility"],
                    };
                }
                if ("dataset_id" in sample || "dataset_version_id" in sample) {
                    return {
                        tableName: "datasets",
                        indexes: ["dataset_id", "dataset_version_id", "collection_id"],
                    };
                }
            }
        }

        // Single collection object
        const obj = data as Record<string, unknown>;
        if (obj.collection_id && Array.isArray(obj.datasets)) {
            return {
                tableName: "collection",
                indexes: ["collection_id", "name"],
            };
        }

        return undefined;
    }
}
