import { randomUUID } from "node:crypto";
import { encode } from "gpt-tokenizer/encoding/cl100k_base";

export interface SectionDraft {
  id: string;
  orderIndex: number;
  heading: string;
  content: string;
  rawContent: string;
  tokenCount: number;
}

export interface ChunkDraft {
  id: string;
  rank: number;
  heading: string;
  content: string;
  rawContent: string;
  sectionIds: string[];
}

export interface ChunkingResult {
  sections: SectionDraft[];
  chunks: ChunkDraft[];
}

export function chunkMarkdown(content: string, options: { maxTokens?: number } = {}): ChunkingResult {
  const maxTokens = options.maxTokens ?? 512;
  const originalSections = buildSections(content);
  const sections: SectionDraft[] = [];
  const chunks: ChunkDraft[] = [];
  let current: SectionDraft[] = [];
  let currentTokens = 0;

  for (const section of originalSections) {
    if (section.tokenCount > maxTokens) {
      if (current.length > 0) {
        chunks.push(buildChunk(current, chunks.length));
        current = [];
        currentTokens = 0;
      }
      for (const split of splitLargeSection(section, maxTokens)) {
        sections.push(split);
        chunks.push(buildChunk([split], chunks.length));
      }
      continue;
    }

    sections.push(section);
    if (current.length === 0 || currentTokens + section.tokenCount <= maxTokens) {
      current.push(section);
      currentTokens += section.tokenCount;
      continue;
    }

    chunks.push(buildChunk(current, chunks.length));
    current = [section];
    currentTokens = section.tokenCount;
  }

  if (current.length > 0) {
    chunks.push(buildChunk(current, chunks.length));
  }

  return { sections, chunks };
}

function buildSections(content: string): SectionDraft[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const sections: SectionDraft[] = [];
  let heading = "Introduction";
  let buffer: string[] = [];

  function flush(): void {
    const raw = buffer.join("\n").trim();
    if (!raw) {
      return;
    }
    sections.push({
      id: randomUUID(),
      orderIndex: sections.length,
      heading,
      content: stripMarkdown(raw),
      rawContent: raw,
      tokenCount: estimateTokens(raw)
    });
    buffer = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flush();
      heading = headingMatch[2].trim();
      buffer.push(line);
      continue;
    }
    if (!line.trim() && buffer.length > 0) {
      buffer.push(line);
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();

  if (sections.length === 0 && content.trim()) {
    sections.push({
      id: randomUUID(),
      orderIndex: 0,
      heading,
      content: stripMarkdown(content),
      rawContent: content,
      tokenCount: estimateTokens(content)
    });
  }
  return sections;
}

function splitLargeSection(section: SectionDraft, maxTokens: number): SectionDraft[] {
  const paragraphs = section.rawContent.split(/\n{2,}/);
  const result: SectionDraft[] = [];
  let buffer: string[] = [];
  let tokens = 0;
  for (const paragraph of paragraphs) {
    const paragraphTokens = estimateTokens(paragraph);
    if (paragraphTokens > maxTokens) {
      if (buffer.length > 0) {
        result.push(cloneSection(section, buffer.join("\n\n"), result.length));
        buffer = [];
        tokens = 0;
      }
      for (const fragment of splitTextByTokenLimit(paragraph, maxTokens)) {
        result.push(cloneSection(section, fragment, result.length));
      }
      continue;
    }
    if (buffer.length > 0 && tokens + paragraphTokens > maxTokens) {
      result.push(cloneSection(section, buffer.join("\n\n"), result.length));
      buffer = [];
      tokens = 0;
    }
    buffer.push(paragraph);
    tokens += paragraphTokens;
  }
  if (buffer.length > 0) {
    result.push(cloneSection(section, buffer.join("\n\n"), result.length));
  }
  return result;
}

function splitTextByTokenLimit(text: string, maxTokens: number): string[] {
  const sentences = splitBySentenceBoundary(text);
  const chunks: string[] = [];
  let buffer = "";
  let bufferTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);
    if (sentenceTokens > maxTokens) {
      if (buffer.trim()) {
        chunks.push(buffer.trim());
        buffer = "";
        bufferTokens = 0;
      }
      chunks.push(...forceSplitByTokenLimit(sentence, maxTokens));
      continue;
    }
    if (!buffer || bufferTokens + sentenceTokens <= maxTokens) {
      buffer += sentence;
      bufferTokens += sentenceTokens;
      continue;
    }
    chunks.push(buffer.trim());
    buffer = sentence;
    bufferTokens = sentenceTokens;
  }

  if (buffer.trim()) {
    chunks.push(buffer.trim());
  }
  return chunks.filter(Boolean);
}

function splitBySentenceBoundary(text: string): string[] {
  const parts = text.match(/[^。！？!?；;\n]+[。！？!?；;\n]?|\n+/gu) ?? [text];
  return parts.filter((part) => part.length > 0);
}

function forceSplitByTokenLimit(text: string, maxTokens: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining) {
    if (estimateTokens(remaining) <= maxTokens) {
      chunks.push(remaining);
      break;
    }

    let cut = findPrefixLengthByTokenLimit(remaining, maxTokens);
    if (cut <= 0) {
      cut = 1;
    }

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }

  return chunks.filter(Boolean);
}

function findPrefixLengthByTokenLimit(text: string, maxTokens: number): number {
  let low = 0;
  let high = text.length;
  let best = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    const tokens = estimateTokens(candidate);
    if (tokens <= maxTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function cloneSection(section: SectionDraft, rawContent: string, offset: number): SectionDraft {
  return {
    id: randomUUID(),
    orderIndex: section.orderIndex + offset / 1000,
    heading: section.heading,
    content: stripMarkdown(rawContent),
    rawContent,
    tokenCount: estimateTokens(rawContent)
  };
}

function buildChunk(sections: SectionDraft[], rank: number): ChunkDraft {
  const heading = sections.find((section) => section.heading)?.heading ?? "Untitled";
  return {
    id: randomUUID(),
    rank,
    heading,
    content: sections.map((section) => section.content).join("\n").trim(),
    rawContent: sections.map((section) => section.rawContent).join("\n\n"),
    sectionIds: sections.map((section) => section.id)
  };
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function estimateTokens(text: string): number {
  return Math.max(1, encode(text).length);
}
