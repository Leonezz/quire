import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { isPreview } from "./api";

if (isPreview) document.documentElement.dataset.preview = "";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
