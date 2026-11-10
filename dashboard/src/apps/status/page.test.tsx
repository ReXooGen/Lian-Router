import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StatusPage } from "./page";

/**
 * The page starts empty and fills from `/status/models`, so a static render can
 * only assert the shell. That is still the part a visitor sees before data
 * arrives, and a spinner-less blank document would read as a broken page.
 */
describe("status page shell", () => {
  const markup = renderToStaticMarkup(createElement(StatusPage));

  test("renders its heading and back link without any data", () => {
    expect(markup).toContain("Models status");
    expect(markup).toContain("Service health timelines for every published model.");
    expect(markup).toContain('href="/"');
  });

  test("shows a loading line rather than an empty document", () => {
    expect(markup).toContain("Reading model status");
  });

  test("renders no timeline rows before data arrives", () => {
    expect(markup).not.toContain('class="st-row"');
    expect(markup).not.toContain('class="st-bar"');
  });

  test("keeps the console entry reachable", () => {
    expect(markup).toContain('href="/console/login"');
  });
});
