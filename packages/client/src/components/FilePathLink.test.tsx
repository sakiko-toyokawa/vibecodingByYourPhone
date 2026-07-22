import { renderToStaticMarkup } from "react-dom/server";
import {
  FilePathLinkModalFooter,
  getFilePathLinkEditorPath,
} from "./FilePathLink.shared.js";

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      message ?? `Expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

function assertIncludes(
  actual: string,
  expectedSubstring: string,
  message?: string,
): void {
  if (!actual.includes(expectedSubstring)) {
    throw new Error(
      message ?? `Expected "${actual}" to include "${expectedSubstring}"`,
    );
  }
}

function testSessionScopedEditorPath(): void {
  assertEqual(
    getFilePathLinkEditorPath({
      basePath: "/remote",
      projectId: "proj-1",
      sessionId: "sess-1",
      filePath: "src/app.ts",
    }),
    "/remote/projects/proj-1/sessions/sess-1/editor?path=src%2Fapp.ts",
  );
}

function testProjectEditorPathWithoutSession(): void {
  assertEqual(
    getFilePathLinkEditorPath({
      basePath: "",
      projectId: "proj-1",
      filePath: "src/app.ts",
    }),
    "/projects/proj-1/editor?path=src%2Fapp.ts",
  );
}

function testModalFooterRendersButtonWhenEditorPathExists(): void {
  const html = renderToStaticMarkup(
    <FilePathLinkModalFooter
      editorPath="/projects/proj-1/editor"
      onOpen={() => {}}
    />,
  );
  assertIncludes(html, "Open in Editor");
  assertIncludes(html, "<button");
}

function testModalFooterSkipsButtonWithoutEditorPath(): void {
  const html = renderToStaticMarkup(
    <FilePathLinkModalFooter editorPath={null} onOpen={() => {}} />,
  );
  assertEqual(html, "");
}

function main(): void {
  const cases: Array<[string, () => void]> = [
    [
      "getFilePathLinkEditorPath prefers session editor routes",
      testSessionScopedEditorPath,
    ],
    [
      "getFilePathLinkEditorPath falls back to project editor routes",
      testProjectEditorPathWithoutSession,
    ],
    [
      "FilePathLink modal footer renders Open in Editor when editorPath exists",
      testModalFooterRendersButtonWhenEditorPathExists,
    ],
    [
      "FilePathLink modal footer hides Open in Editor without editorPath",
      testModalFooterSkipsButtonWithoutEditorPath,
    ],
  ];

  for (const [name, run] of cases) {
    run();
    console.log(`PASS ${name}`);
  }
}

main();
