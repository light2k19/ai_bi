import { zodToJsonSchema } from "zod-to-json-schema";
import { PageBundle, PageDefinition, Dataset, Filter, Widget } from "./page";

/** JSON Schemas for the page format (authoring kit, editors, AI tool definitions). */
export function pageJsonSchemas() {
  return {
    pageBundle: zodToJsonSchema(PageBundle, { name: "PageBundle", $refStrategy: "none" }),
    page: zodToJsonSchema(PageDefinition, { name: "PageDefinition", $refStrategy: "none" }),
    dataset: zodToJsonSchema(Dataset, { $refStrategy: "none" }),
    filter: zodToJsonSchema(Filter, { $refStrategy: "none" }),
    widget: zodToJsonSchema(Widget, { $refStrategy: "seen" }),
  };
}
