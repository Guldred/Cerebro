import { CerebroConfig } from '../../config/config';
import { EvidenceItem, GroundedAnswer, LlmProvider, parseCitations } from '../llm.interface';
import { GROUNDED_SYSTEM_PROMPT, buildUserPrompt } from '../prompt';

/** Azure OpenAI chat completions (EU region for GDPR). Needs AZURE_OPENAI_* env vars. */
export class AzureOpenAILlmProvider implements LlmProvider {
  readonly model: string;

  constructor(private readonly cfg: CerebroConfig['llm']['azure']) {
    if (!cfg.endpoint || !cfg.apiKey) {
      throw new Error(
        'LLM_PROVIDER=azure-openai requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY',
      );
    }
    this.model = cfg.deployment;
  }

  async generateGroundedAnswer(
    question: string,
    evidence: EvidenceItem[],
  ): Promise<GroundedAnswer> {
    const url =
      `${this.cfg.endpoint.replace(/\/$/, '')}/openai/deployments/${this.cfg.deployment}` +
      `/chat/completions?api-version=${this.cfg.apiVersion}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': this.cfg.apiKey },
      body: JSON.stringify({
        temperature: 0,
        messages: [
          { role: 'system', content: GROUNDED_SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(question, evidence) },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Azure chat completion failed: ${res.status} ${body}`);
    }

    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const answer = json.choices[0]?.message?.content?.trim() ?? '';
    return { answer, usedCitations: parseCitations(answer) };
  }
}
