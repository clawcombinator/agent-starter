// ============================================================
// ExampleReviewCapability — reference capability implementation.
//
// Demonstrates the Capability interface pattern:
// 1. Declare config (pricing, SLA, input schema)
// 2. Implement execute() with real logic
// 3. Return structured output
//
// This capability downloads a document, extracts its text,
// and uses Claude to analyse it for risks and key terms.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Capability, CapabilityConfig } from '../types.js';

// ----------------------------------------------------------
// Input validation schema (Zod)
// ----------------------------------------------------------

const ReviewInputSchema = z.object({
  document_url: z.string().url({ message: 'document_url must be a valid URL' }),
  analysis_depth: z.enum(['shallow', 'deep']).default('shallow'),
  focus_areas: z
    .array(z.string())
    .default(['liability', 'payment_terms', 'termination', 'ip_ownership', 'indemnification']),
});

type ReviewInput = z.infer<typeof ReviewInputSchema>;

// ----------------------------------------------------------
// Output types
// ----------------------------------------------------------

export interface RiskItem {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  clauseReference?: string;
  recommendation: string;
}

export interface ReviewOutput {
  risks: RiskItem[];
  keyTerms: string[];
  summary: string;
  confidence: number;            // 0–1 score
  processingTimeMs: number;
  documentUrl: string;
  analysisDepth: 'shallow' | 'deep';
}

// Expected JSON structure from the LLM
interface LLMAnalysis {
  risks: Array<{
    type: string;
    severity: string;
    description: string;
    clause_reference?: string;
    recommendation: string;
  }>;
  key_terms: string[];
  executive_summary: string;
  confidence_score: number;
}

// ----------------------------------------------------------
// Capability implementation
// ----------------------------------------------------------

export class ExampleReviewCapability implements Capability {
  readonly config: CapabilityConfig = {
    id: 'example_review',
    name: 'Document Review',
    description: 'Analyse a document for risks and key terms. Returns structured findings.',
    version: '1.0.0',
    pricing: {
      model: 'per_call',
      baseCostUsd: 0.5,
    },
    sla: {
      p95LatencyMs: 10_000,
      availability: 0.999,
    },
    safety: {
      maxInputSizeBytes: 50 * 1024 * 1024, // 50 MB
      allowedFileTypes: ['pdf', 'docx', 'txt', 'md'],
      requiresHumanApproval: false,
    },
    inputSchema: ReviewInputSchema._def as object,
  };

  private readonly anthropic: Anthropic;

  constructor(apiKey?: string) {
    this.anthropic = new Anthropic({ apiKey: apiKey ?? process.env['ANTHROPIC_API_KEY'] });
  }

  async execute(rawInput: Record<string, unknown>): Promise<ReviewOutput> {
    const startTime = Date.now();

    // Validate and coerce input
    const input: ReviewInput = ReviewInputSchema.parse(rawInput);

    // Fetch the document text
    const documentText = await this.fetchDocumentText(input.document_url);

    // Analyse with LLM
    const analysis = await this.analyseWithLLM(documentText, input);

    // Normalise severity strings from the LLM
    const risks: RiskItem[] = analysis.risks.map((r) => ({
      type: r.type,
      severity: this.normaliseSeverity(r.severity),
      description: r.description,
      clauseReference: r.clause_reference,
      recommendation: r.recommendation,
    }));

    return {
      risks,
      keyTerms: analysis.key_terms,
      summary: analysis.executive_summary,
      confidence: Math.min(1, Math.max(0, analysis.confidence_score)),
      processingTimeMs: Date.now() - startTime,
      documentUrl: input.document_url,
      analysisDepth: input.analysis_depth,
    };
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private async fetchDocumentText(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });

    if (!response.ok) {
      throw new Error(`Failed to fetch document at ${url}: HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('text/') || contentType.includes('application/json')) {
      return await response.text();
    }

    // For binary formats (PDF, DOCX) we return the raw text representation.
    // In production you would pipe through a document parser (pdf-parse, mammoth, etc.).
    // For this starter kit, we treat the response as UTF-8 text.
    const buffer = await response.arrayBuffer();
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }

  private async analyseWithLLM(
    documentText: string,
    input: ReviewInput,
  ): Promise<LLMAnalysis> {
    const model =
      process.env['LLM_MODEL'] ?? 'claude-3-5-sonnet-20241022';

    const prompt = this.buildPrompt(documentText, input);

    const message = await this.anthropic.messages.create({
      model,
      max_tokens: input.analysis_depth === 'deep' ? 4096 : 2048,
      temperature: 0,  // Deterministic for legal/risk analysis
      messages: [{ role: 'user', content: prompt }],
    });

    const textContent = message.content.find((c) => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('LLM returned no text content');
    }

    // Extract JSON from the response (handle markdown code fences)
    const jsonMatch = textContent.text.match(/```(?:json)?\s*([\s\S]*?)```/) ??
      textContent.text.match(/(\{[\s\S]*\})/);

    if (!jsonMatch) {
      throw new Error('LLM response did not contain valid JSON');
    }

    try {
      return JSON.parse(jsonMatch[1]!) as LLMAnalysis;
    } catch {
      throw new Error(`Failed to parse LLM JSON response: ${jsonMatch[1]!.slice(0, 200)}`);
    }
  }

  private buildPrompt(text: string, input: ReviewInput): string {
    const focusAreasStr = input.focus_areas.join(', ');
    const depthInstruction =
      input.analysis_depth === 'deep'
        ? 'Perform a comprehensive analysis, examining every clause in detail.'
        : 'Perform a high-level review, focusing on the most significant issues.';

    // Truncate very long documents to fit context window
    const truncated = text.length > 50_000 ? text.slice(0, 50_000) + '\n[... document truncated ...]' : text;

    return `You are an expert document analyst. ${depthInstruction}

Focus areas: ${focusAreasStr}

Document text:
"""
${truncated}
"""

Analyse this document and return a JSON object with EXACTLY this structure:
{
  "risks": [
    {
      "type": "<risk category>",
      "severity": "<low|medium|high|critical>",
      "description": "<clear description of the risk>",
      "clause_reference": "<section/clause number if identifiable>",
      "recommendation": "<specific mitigation recommendation>"
    }
  ],
  "key_terms": ["<term1>", "<term2>", ...],
  "executive_summary": "<2-3 sentence summary of the document and its main concerns>",
  "confidence_score": <0.0 to 1.0>
}

Return ONLY the JSON object, no other text.`;
  }

  private normaliseSeverity(raw: string): RiskItem['severity'] {
    const lower = raw.toLowerCase().trim();
    if (['critical', 'high', 'medium', 'low'].includes(lower)) {
      return lower as RiskItem['severity'];
    }
    // Map common synonyms
    if (['severe', 'extreme', 'urgent'].includes(lower)) return 'critical';
    if (['significant', 'major', 'elevated'].includes(lower)) return 'high';
    if (['moderate', 'normal'].includes(lower)) return 'medium';
    return 'low';
  }
}
