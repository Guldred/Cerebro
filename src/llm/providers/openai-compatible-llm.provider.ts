import { CerebroConfig } from '../../config/config';
import { EvidenceItem, GroundedAnswer, LlmProvider, parseCitations } from '../llm.interface';
import { GROUNDED_SYSTEM_PROMPT, buildUserPrompt } from '../prompt';

/**
 * Any OpenAI-compatible chat endpoint — a self-hosted EU LLM (vLLM, Ollama,
 * text-generation-inference) for full data residency. Set LLM_BASE_URL/LLM_MODEL.
 */
export class OpenAICompatibleLlmProvider implements LlmProvider {
  readonly model: string;

  constructor(private readonly cfg: CerebroConfig['llm']['openaiCompatible']) {
    this.model = cfg.model;
  }

  async generateGroundedAnswer(
    question: string,
    evidence: EvidenceItem[],
  ): Promise<GroundedAnswer> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;

    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: 0,
        messages: [
          { role: 'system', content: GROUNDED_SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(question, evidence) },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Chat completion failed: ${res.status} ${body}`);
    }

    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const answer = json.choices[0]?.message?.content?.trim() ?? '';
    return { answer, usedCitations: parseCitations(answer) };
  }
}
