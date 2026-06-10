import { createRoot } from "react-dom/client";
import { appTitle } from "./title";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root element");
}

createRoot(root).render(<h1>{appTitle()}</h1>);
