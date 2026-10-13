import { defineServerSkill } from "@aibi/skill-sdk";
import { transformCatalogue } from "@aibi/transforms";

export default defineServerSkill({
  catalogue: () => ({ transforms: transformCatalogue("transform-core") }),
});
