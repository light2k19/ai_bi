import type { ClientSkillModule } from "@aibi/runtime-api";
import { TableWidget } from "./Table";
import { PivotWidget } from "./Pivot";
import "./styles.css";

const mod: ClientSkillModule = {
  widgets: [
    { type: "table", component: TableWidget },
    { type: "pivot", component: PivotWidget },
  ],
};

export default mod;
