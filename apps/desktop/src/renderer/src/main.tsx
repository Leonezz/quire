import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { isPreview } from "./api";
import { RenderHarness, RenderQueryError } from "./RenderHarness";
import { parseRenderQuery } from "./renderReadiness";

if (isPreview) document.documentElement.dataset.preview = "";

// `?render=<id>`: the article column alone, for the eval capture (eval/render); everything else is the app.
const render = parseRenderQuery(location.search);
const page = render === undefined ? <App /> : "error" in render ? <RenderQueryError message={render.error} /> : <RenderHarness {...render} />;

createRoot(document.getElementById("root")!).render(<StrictMode>{page}</StrictMode>);
