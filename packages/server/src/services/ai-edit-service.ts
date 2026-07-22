import { randomUUID } from "node:crypto";
import {
  ALL_PROVIDERS,
  DEFAULT_PROVIDER,
  type PatchHunk,
  type ProviderName,
} from "@yep-anywhere/shared";
import { computeEditAugment } from "../augments/edit-augments.js";
import { getProvider } from "../sdk/providers/index.js";
import type { SDKMessage } from "../sdk/types.js";

export interface AiEditRequest {
  projectPath: string;
  filePath: string;
  fileContent: string;
  instruction: string;
  selectedText?: string;
  provider?: string;
  model?: string;
  globalInstructions?: string;
}

export interface AiEditResult {
  content: string;
  provider: ProviderName;
  model?: string;
  structuredPatch: PatchHunk[];
  diffHtml: string;
}

function isProviderName(value: string | undefined): value is ProviderName {
  return !!value && ALL_PROVIDERS.includes(value as ProviderName);
}

function extractAssistantText(message: SDKMessage): string {
  const content = message.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object" || !("type" in block)) {
        return "";
      }
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "thinking") {
        return "";
      }
      if (typeof block.content === "string") {
        return block.content;
      }
      return "";
    })
    .join("");
}

function extractUpdatedFile(responseText: string): string {
  const tagged = responseText.match(
    /<updated-file>\s*([\s\S]*?)\s*<\/updated-file>/i,
  );
  if (tagged?.[1] !== undefined) {
    return tagged[1];
  }

  const fenced = responseText.match(/```[^\n]*\r?\n([\s\S]*?)\r?\n```/);
  if (fenced?.[1] !== undefined) {
    return fenced[1];
  }

  return responseText.trim();
}

function buildAiEditPrompt(input: AiEditRequest): string {
  const selectionSection =
    input.selectedText && input.selectedText.trim().length > 0
      ? `Selected text:\n<<<SELECTION\n${input.selectedText}\nSELECTION`
      : "Selected text:\n<none>";

  return [
    "You are applying a targeted edit to one source file.",
    "Do not use tools.",
    "Preserve code outside the requested change unless the instruction requires otherwise.",
    "Return the complete updated file content only inside these exact tags:",
    "<updated-file>",
    "FULL FILE CONTENT",
    "</updated-file>",
    "Do not include markdown fences or any explanation.",
    "",
    `File path: ${input.filePath}`,
    "",
    "Instruction:",
    input.instruction,
    "",
    selectionSection,
    "",
    "Current file content:",
    "<<<FILE",
    input.fileContent,
    "FILE",
  ].join("\n");
}

export class AiEditService {
  async suggestEdit(input: AiEditRequest): Promise<AiEditResult> {
    const providerName = isProviderName(input.provider)
      ? input.provider
      : DEFAULT_PROVIDER;
    const provider = getProvider(providerName);
    if (!provider) {
      throw new Error(`Provider "${providerName}" is not available`);
    }

    const authStatus = await provider.getAuthStatus();
    if (!authStatus.installed) {
      throw new Error(`Provider "${providerName}" is not installed`);
    }
    if (!authStatus.authenticated && !authStatus.enabled) {
      throw new Error(`Provider "${providerName}" is not configured`);
    }

    const session = await provider.startSession({
      cwd: input.projectPath,
      initialMessage: { text: buildAiEditPrompt(input) },
      permissionMode: "default",
      model: input.model,
      globalInstructions: input.globalInstructions,
      onToolApproval: async () => ({
        behavior: "deny",
        message:
          "Tool use is disabled for this request. Return the updated file content directly.",
        interrupt: false,
      }),
    });

    let bestAssistantText = "";
    let resolvedModel = input.model;

    try {
      for await (const message of session.iterator) {
        if (
          typeof message.message?.model === "string" &&
          message.message.model.trim().length > 0
        ) {
          resolvedModel = message.message.model;
        }

        if (message.type !== "assistant") {
          continue;
        }

        const text = extractAssistantText(message).trim();
        if (text.length >= bestAssistantText.length) {
          bestAssistantText = text;
        }
      }
    } finally {
      session.abort();
    }

    const updatedContent = extractUpdatedFile(bestAssistantText);
    if (!updatedContent.trim()) {
      throw new Error("AI provider returned an empty edit result");
    }

    const augment = await computeEditAugment(randomUUID(), {
      file_path: input.filePath,
      old_string: input.fileContent,
      new_string: updatedContent,
    });

    return {
      content: updatedContent,
      provider: providerName,
      model: resolvedModel,
      structuredPatch: augment.structuredPatch as PatchHunk[],
      diffHtml: augment.diffHtml,
    };
  }
}
