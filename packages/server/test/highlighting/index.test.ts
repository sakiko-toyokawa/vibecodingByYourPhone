import { describe, expect, it } from "vitest";
import {
  __test__,
  getLanguageForPath,
  highlightCode,
  highlightFile,
} from "../../src/highlighting/index.js";

const { MAX_LINES, EXTENSION_TO_LANG } = __test__;

describe("getLanguageForPath", () => {
  describe("common file extensions", () => {
    it("maps .ts to typescript", () => {
      expect(getLanguageForPath("/path/to/file.ts")).toBe("typescript");
    });

    it("maps .tsx to tsx", () => {
      expect(getLanguageForPath("/path/to/component.tsx")).toBe("tsx");
    });

    it("maps .js to javascript", () => {
      expect(getLanguageForPath("/path/to/file.js")).toBe("javascript");
    });

    it("maps .jsx to jsx", () => {
      expect(getLanguageForPath("/path/to/component.jsx")).toBe("jsx");
    });

    it("maps .mjs to javascript", () => {
      expect(getLanguageForPath("/path/to/module.mjs")).toBe("javascript");
    });

    it("maps .cjs to javascript", () => {
      expect(getLanguageForPath("/path/to/module.cjs")).toBe("javascript");
    });

    it("maps .py to python", () => {
      expect(getLanguageForPath("/path/to/script.py")).toBe("python");
    });

    it("maps .go to go", () => {
      expect(getLanguageForPath("/path/to/main.go")).toBe("go");
    });

    it("maps .rs to rust", () => {
      expect(getLanguageForPath("/path/to/lib.rs")).toBe("rust");
    });

    it("maps .java to java", () => {
      expect(getLanguageForPath("/path/to/Main.java")).toBe("java");
    });
  });

  describe("shell scripts", () => {
    it("maps .sh to bash", () => {
      expect(getLanguageForPath("/path/to/script.sh")).toBe("bash");
    });

    it("maps .bash to bash", () => {
      expect(getLanguageForPath("/path/to/script.bash")).toBe("bash");
    });

    it("maps .zsh to bash", () => {
      expect(getLanguageForPath("/path/to/script.zsh")).toBe("bash");
    });

    it("maps .fish to fish", () => {
      expect(getLanguageForPath("/path/to/script.fish")).toBe("fish");
    });

    it("maps .ps1 to powershell", () => {
      expect(getLanguageForPath("/path/to/script.ps1")).toBe("powershell");
    });
  });

  describe("config files", () => {
    it("maps .json to json", () => {
      expect(getLanguageForPath("/path/to/config.json")).toBe("json");
    });

    it("maps .jsonc to jsonc", () => {
      expect(getLanguageForPath("/path/to/tsconfig.jsonc")).toBe("jsonc");
    });

    it("maps .yaml to yaml", () => {
      expect(getLanguageForPath("/path/to/config.yaml")).toBe("yaml");
    });

    it("maps .yml to yaml", () => {
      expect(getLanguageForPath("/path/to/config.yml")).toBe("yaml");
    });

    it("maps .toml to toml", () => {
      expect(getLanguageForPath("/path/to/Cargo.toml")).toBe("toml");
    });

    it("maps .xml to xml", () => {
      expect(getLanguageForPath("/path/to/pom.xml")).toBe("xml");
    });
  });

  describe("web technologies", () => {
    it("maps .html to html", () => {
      expect(getLanguageForPath("/path/to/index.html")).toBe("html");
    });

    it("maps .htm to html", () => {
      expect(getLanguageForPath("/path/to/page.htm")).toBe("html");
    });

    it("maps .css to css", () => {
      expect(getLanguageForPath("/path/to/styles.css")).toBe("css");
    });

    it("maps .scss to scss", () => {
      expect(getLanguageForPath("/path/to/styles.scss")).toBe("scss");
    });

    it("maps .sass to sass", () => {
      expect(getLanguageForPath("/path/to/styles.sass")).toBe("sass");
    });

    it("maps .less to less", () => {
      expect(getLanguageForPath("/path/to/styles.less")).toBe("less");
    });
  });

  describe("C/C++ files", () => {
    it("maps .c to c", () => {
      expect(getLanguageForPath("/path/to/main.c")).toBe("c");
    });

    it("maps .h to c", () => {
      expect(getLanguageForPath("/path/to/header.h")).toBe("c");
    });

    it("maps .cpp to cpp", () => {
      expect(getLanguageForPath("/path/to/main.cpp")).toBe("cpp");
    });

    it("maps .hpp to cpp", () => {
      expect(getLanguageForPath("/path/to/header.hpp")).toBe("cpp");
    });

    it("maps .cc to cpp", () => {
      expect(getLanguageForPath("/path/to/main.cc")).toBe("cpp");
    });
  });

  describe("diff and patch files", () => {
    it("maps .diff to diff", () => {
      expect(getLanguageForPath("/path/to/changes.diff")).toBe("diff");
    });

    it("maps .patch to diff", () => {
      expect(getLanguageForPath("/path/to/fix.patch")).toBe("diff");
    });
  });

  describe("markdown", () => {
    it("maps .md to markdown", () => {
      expect(getLanguageForPath("/path/to/README.md")).toBe("markdown");
    });

    it("maps .markdown to markdown", () => {
      expect(getLanguageForPath("/path/to/doc.markdown")).toBe("markdown");
    });
  });

  describe("edge cases", () => {
    it("returns null for unknown extension", () => {
      expect(getLanguageForPath("/path/to/file.unknown")).toBeNull();
    });

    it("returns null for file without extension", () => {
      expect(getLanguageForPath("/path/to/Makefile")).toBeNull();
    });

    it("handles case insensitivity for extension", () => {
      expect(getLanguageForPath("/path/to/FILE.TS")).toBe("typescript");
      expect(getLanguageForPath("/path/to/FILE.PY")).toBe("python");
    });

    it("handles multiple dots in filename", () => {
      expect(getLanguageForPath("/path/to/file.test.ts")).toBe("typescript");
      expect(getLanguageForPath("/path/to/app.module.ts")).toBe("typescript");
    });

    it("returns null for empty path", () => {
      expect(getLanguageForPath("")).toBeNull();
    });

    it("handles paths with special characters", () => {
      expect(getLanguageForPath("/path/to/my file [1].ts")).toBe("typescript");
    });
  });

  describe("EXTENSION_TO_LANG constant coverage", () => {
    it("has expected number of extensions mapped", () => {
      const extensionCount = Object.keys(EXTENSION_TO_LANG).length;
      // Verify we have a reasonable number of mappings
      expect(extensionCount).toBeGreaterThan(50);
    });

    it("all mapped extensions return valid languages", () => {
      for (const ext of Object.keys(EXTENSION_TO_LANG)) {
        const lang = getLanguageForPath(`/test/file.${ext}`);
        expect(lang).not.toBeNull();
      }
    });
  });
});

describe("highlightCode", () => {
  it("returns highlighted HTML for known language", async () => {
    const result = await highlightCode("const x = 1;", "typescript");

    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected result");
    expect(result.html).toContain("<pre");
    expect(result.html).toContain("shiki");
    expect(result.language).toBe("typescript");
    expect(result.truncated).toBe(false);
  });

  it("returns null for unknown language", async () => {
    const result = await highlightCode("some code", "unknownlang");

    expect(result).toBeNull();
  });

  it("accepts ts as a valid Shiki language directly", async () => {
    const result = await highlightCode("const x = 1;", "ts");

    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected result");
    // Shiki has both 'ts' and 'typescript' as valid bundled languages.
    // Since 'ts' is found in bundledLanguages, it's used directly without
    // going through EXTENSION_TO_LANG mapping.
    expect(result.language).toBe("ts");
  });

  it("uses EXTENSION_TO_LANG for unknown Shiki languages", async () => {
    // 'htm' is not a Shiki bundled language but maps to 'html' via EXTENSION_TO_LANG
    const result = await highlightCode("<html></html>", "htm");

    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected result");
    expect(result.language).toBe("html");
  });

  it("handles empty code", async () => {
    const result = await highlightCode("", "typescript");

    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected result");
    expect(result.lineCount).toBe(1);
  });

  it("counts lines correctly", async () => {
    const code = "line1\nline2\nline3";
    const result = await highlightCode(code, "typescript");

    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected result");
    expect(result.lineCount).toBe(3);
  });

  it("truncates code exceeding MAX_LINES", async () => {
    const lines = Array.from(
      { length: MAX_LINES + 100 },
      (_, i) => `// line ${i}`,
    );
    const code = lines.join("\n");

    const result = await highlightCode(code, "typescript");

    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected result");
    expect(result.truncated).toBe(true);
    expect(result.lineCount).toBe(MAX_LINES + 100); // Original line count
    // HTML should only contain MAX_LINES lines worth of content
  });

  it("does not truncate code at exactly MAX_LINES", async () => {
    const lines = Array.from({ length: MAX_LINES }, (_, i) => `// line ${i}`);
    const code = lines.join("\n");

    const result = await highlightCode(code, "typescript");

    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected result");
    expect(result.truncated).toBe(false);
    expect(result.lineCount).toBe(MAX_LINES);
  });

  it("highlights different languages correctly", async () => {
    const pythonResult = await highlightCode("def foo(): pass", "python");
    const jsResult = await highlightCode("function foo() {}", "javascript");
    const goResult = await highlightCode("func main() {}", "go");

    expect(pythonResult).not.toBeNull();
    expect(jsResult).not.toBeNull();
    expect(goResult).not.toBeNull();

    if (pythonResult === null) throw new Error("Expected pythonResult");
    if (jsResult === null) throw new Error("Expected jsResult");
    if (goResult === null) throw new Error("Expected goResult");

    expect(pythonResult.language).toBe("python");
    expect(jsResult.language).toBe("javascript");
    expect(goResult.language).toBe("go");
  });

  it("handles special characters in code", async () => {
    const result = await highlightCode("<div>Hello & World</div>", "html");

    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected result");
    // Shiki uses hex entity encoding (&#x3C; for <, &#x26; for &)
    // rather than named entities (&lt;, &amp;)
    expect(result.html).toContain("&#x3C;"); // < escaped
    expect(result.html).toContain("&#x26;"); // & escaped
  });

  it("handles unicode in code", async () => {
    const result = await highlightCode('const emoji = "🚀";', "typescript");

    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected result");
    expect(result.html).toBeTruthy();
  });

  it("uses CSS variables theme", async () => {
    const result = await highlightCode("const x = 1;", "typescript");

    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected result");
    // CSS variables theme outputs style attributes with var(--shiki-...)
    expect(result.html).toContain("--shiki");
  });

  it("loads languages on demand", async () => {
    // Test a language that's not in the preloaded list
    const result = await highlightCode("module Test where", "haskell");

    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected result");
    expect(result.language).toBe("haskell");
  });

  it("highlights diff content", async () => {
    const diffCode = `@@ -1,3 +1,3 @@
 context
-old
+new`;

    const result = await highlightCode(diffCode, "diff");

    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected result");
    expect(result.language).toBe("diff");
  });
});

describe("highlightFile", () => {
  it("highlights file based on extension", async () => {
    const result = await highlightFile("const x = 1;", "/path/to/file.ts");

    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected result");
    expect(result.language).toBe("typescript");
  });

  it("returns null for unknown file type", async () => {
    const result = await highlightFile("some content", "/path/to/file.unknown");

    expect(result).toBeNull();
  });

  it("returns null for file without extension", async () => {
    const result = await highlightFile("content", "/path/to/Dockerfile");

    expect(result).toBeNull();
  });

  it("works with Python files", async () => {
    const result = await highlightFile("def foo(): pass", "/app/script.py");

    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected result");
    expect(result.language).toBe("python");
  });

  it("works with config files", async () => {
    const result = await highlightFile('{"key": "value"}', "/app/config.json");

    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected result");
    expect(result.language).toBe("json");
  });
});

describe("MAX_LINES constant", () => {
  it("is a reasonable value", () => {
    expect(MAX_LINES).toBeGreaterThan(100);
    expect(MAX_LINES).toBeLessThanOrEqual(10000);
  });

  it("is exactly 10000", () => {
    // Document the actual value for regression detection
    expect(MAX_LINES).toBe(10000);
  });
});
