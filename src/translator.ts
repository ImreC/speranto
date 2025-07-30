import ollama from "ollama";

interface TranslatorOptions {
  model: string;
  temperature: number;
  sourceLang: string;
  targetLang: string;
}

export class Translator {
  private options: TranslatorOptions;

  constructor(options: TranslatorOptions) {
    this.options = options;
  }

  async translateText(text: string): Promise<string> {
    if (!text.trim()) return text;
    try {
      const response = await ollama.generate({
        model: this.options.model,
        prompt: `Translate: "${text}" from ${this.options.sourceLang} to ${this.options.targetLang}. Respond with only the translation. Be casual, but don't overdo it`,
        options: {
          temperature: this.options.temperature,
        },
      });
      console.log(
        `Translated text ${text} to ${
          this.options.targetLang
        }: ${response.response.trim()}`
      );
      return response.response.trim();
    } catch (error) {
      console.error(`Translation error for text: "${text}"`, error);
      throw error;
    }
  }
}
