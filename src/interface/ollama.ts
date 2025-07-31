import ollama from "ollama";
import {
  LLMInterface,
  type LLMGenerateOptions,
  type LLMResponse,
} from "./llm.interface";

export class OllamaProvider extends LLMInterface {
  constructor(model: string) {
    super(model);
  }

  async generate(
    prompt: string,
    options?: LLMGenerateOptions
  ): Promise<LLMResponse> {
    const response = await ollama.generate({
      model: this.model,
      prompt,
      options: {
        temperature: options?.temperature,
        num_predict: options?.maxTokens,
        top_p: options?.topP,
        top_k: options?.topK,
        ...options,
      },
    });

    return {
      content: response.response.trim(),
      model: this.model,
      finishReason: response.done ? "stop" : undefined,
      usage: response.eval_count
        ? {
            promptTokens: response.prompt_eval_count,
            completionTokens: response.eval_count,
            totalTokens:
              (response.prompt_eval_count || 0) + response.eval_count,
          }
        : undefined,
    };
  }

  async isModelAvailable(): Promise<boolean> {
    try {
      const models = await ollama.list();
      console.log("Available models: ", models.models);
      console.log("Model: ", this.model);
      return models.models.some((m) => m.name.includes(this.model));
    } catch (error) {
      console.error("Error checking Ollama models:", error);
      return false;
    }
  }

  async isModelLoaded(
    onProgress?: (progress: {
      status: string;
      digest: string;
      total: number;
      completed: number;
      percentage: number;
    }) => void
  ): Promise<boolean> {
    const isAvailable = await this.isModelAvailable();
    console.log("Available", isAvailable);

    if (isAvailable) return true;

    console.log(
      `Model ${this.model} not found locally. Pulling from Ollama...`
    );

    try {
      const stream = await ollama.pull({
        model: this.model,
        stream: true,
      });

      for await (const progress of stream) {
        if (onProgress) {
          const percentage =
            progress.total > 0
              ? Math.round((progress.completed / progress.total) * 100)
              : 0;

          onProgress({
            ...progress,
            percentage,
          });
        }

        // Log progress to console as well
        if (progress.total > 0) {
          const percentage = Math.round(
            (progress.completed / progress.total) * 100
          );
          console.log(
            `Pulling ${this.model}: ${progress.status} - ${percentage}% (${progress.completed}/${progress.total})`
          );
        } else {
          console.log(`Pulling ${this.model}: ${progress.status}`);
        }
      }

      console.log(`Model ${this.model} pulled successfully`);
      return true;
    } catch (error) {
      console.error(`Error pulling model ${this.model}:`, error);
      throw new Error(`Failed to pull model ${this.model}: ${error}`);
    }
  }
}
