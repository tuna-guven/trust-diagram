// Bootstrap (DESIGN.md 11): frame check, then mount the UI.
import { createElement, createSvgElement } from "./ui/dom";

function main(): void {
  // frame-ancestors is ignored in a meta CSP (DESIGN.md 10.3), so refuse to render when framed.
  if (window.top !== window.self) {
    document.body.replaceChildren(createElement("p", {}, ["trustchain cannot run inside a frame."]));
    return;
  }

  const root = document.getElementById("tc-app");
  if (root === null) throw new Error("Missing #tc-app element in index.html");

  root.replaceChildren(
    createElement("header", { class: "toolbar" }, [createElement("h1", {}, ["trustchain"])]),
    createElement("main", { class: "workspace" }, [
      createSvgElement("svg", { class: "canvas", role: "img", "aria-label": "Diagram canvas (empty)" }),
    ]),
  );
}

main();
